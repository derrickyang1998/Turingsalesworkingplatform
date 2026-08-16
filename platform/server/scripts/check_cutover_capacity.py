#!/usr/bin/env python3
"""Plan the additional filesystem capacity needed for a Linux cutover or restore."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from dataclasses import dataclass, field
from typing import Dict, Mapping, Optional, Sequence, Tuple


MIB = 1024 * 1024
MINIMUM_MARGIN_BYTES = 512 * MIB
MINIMUM_MARGIN_INODES = 1024
REPORT_CONTRACT = "tm-cutover-capacity-v1"
FIXTURE_CONTRACT = "tm-cutover-capacity-fixture-v1"
WINDOWS_REPARSE_POINT = 0x400
TARGET_KEYS = (
    "backup-root",
    "database-path",
    "live-dir",
    "parser-state-root",
    "ppt-cache-root",
)


class CapacityError(Exception):
    """A safe, operator-facing capacity planning failure."""


def is_link_or_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & WINDOWS_REPARSE_POINT
    )


@dataclass(frozen=True)
class TargetObservation:
    st_dev: int
    available_bytes: int
    available_inodes: int


@dataclass(frozen=True)
class TreeMeasurement:
    bytes: int
    inodes: int

    def __add__(self, other: "TreeMeasurement") -> "TreeMeasurement":
        return TreeMeasurement(self.bytes + other.bytes, self.inodes + other.inodes)


@dataclass
class DevicePlan:
    st_dev: int
    available_bytes: int
    available_inodes: int
    targets: set[str] = field(default_factory=set)
    components: Dict[str, int] = field(default_factory=dict)
    inode_components: Dict[str, int] = field(default_factory=dict)

    def add_target(
        self,
        target: str,
        available_bytes: int,
        available_inodes: int,
    ) -> None:
        self.targets.add(target)
        self.available_bytes = min(self.available_bytes, available_bytes)
        self.available_inodes = min(self.available_inodes, available_inodes)

    def add_component(self, name: str, amount: int, *, inode: bool = False) -> None:
        if amount < 0:
            raise CapacityError(f"negative capacity component: {name}")
        components = self.inode_components if inode else self.components
        components[name] = components.get(name, 0) + amount

    def render(self) -> dict:
        required_bytes = sum(self.components.values())
        margin_bytes = max(MINIMUM_MARGIN_BYTES, (required_bytes + 9) // 10)
        required_with_margin_bytes = required_bytes + margin_bytes
        required_inodes = sum(self.inode_components.values())
        margin_inodes = max(MINIMUM_MARGIN_INODES, (required_inodes + 9) // 10)
        required_with_margin_inodes = required_inodes + margin_inodes
        byte_sufficient = self.available_bytes >= required_with_margin_bytes
        inode_sufficient = self.available_inodes >= required_with_margin_inodes
        return {
            "available_bytes": self.available_bytes,
            "available_inodes": self.available_inodes,
            "byte_sufficient": byte_sufficient,
            "components": dict(sorted(self.components.items())),
            "inode_components": dict(sorted(self.inode_components.items())),
            "inode_sufficient": inode_sufficient,
            "margin_bytes": margin_bytes,
            "margin_inodes": margin_inodes,
            "required_bytes": required_bytes,
            "required_inodes": required_inodes,
            "required_with_margin_bytes": required_with_margin_bytes,
            "required_with_margin_inodes": required_with_margin_inodes,
            "st_dev": self.st_dev,
            "sufficient": byte_sufficient and inode_sufficient,
            "targets": sorted(self.targets),
        }


def parse_arguments(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check additional filesystem capacity required for cutover or restore."
    )
    parser.add_argument("--mode", choices=("cutover", "restore"), default="cutover")
    parser.add_argument("--backup-root", required=True)
    parser.add_argument("--parser-state-root", required=True)
    parser.add_argument("--database-path", required=True)
    parser.add_argument("--ppt-cache-root", required=True)
    parser.add_argument("--live-dir", required=True)
    parser.add_argument("--candidate-dir")
    parser.add_argument("--parser-stage")
    parser.add_argument("--restore-snapshot")
    parser.add_argument("--fixture-json")
    return parser.parse_args(argv)


def absolute_path(value: str) -> str:
    if not value or "\x00" in value:
        raise CapacityError("capacity paths must be non-empty filesystem paths")
    return os.path.abspath(value)


def lstat_path(label: str, path: str) -> os.stat_result:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as error:
        raise CapacityError(f"{label} does not exist") from error
    if is_link_or_reparse(metadata):
        raise CapacityError(f"{label} is a symbolic link")
    return metadata


def require_directory(label: str, path: str) -> os.stat_result:
    metadata = lstat_path(label, path)
    if not stat.S_ISDIR(metadata.st_mode):
        raise CapacityError(f"{label} must be a directory")
    return metadata


def require_regular_file(label: str, path: str) -> os.stat_result:
    metadata = lstat_path(label, path)
    if not stat.S_ISREG(metadata.st_mode):
        raise CapacityError(f"{label} must be a regular file")
    return metadata


def optional_lstat(label: str, path: str) -> Optional[os.stat_result]:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return None
    if is_link_or_reparse(metadata):
        raise CapacityError(f"{label} is a symbolic link")
    return metadata


def measure_tree(
    label: str,
    root: str,
    *,
    optional: bool = False,
    ignore_links: bool = False,
) -> TreeMeasurement:
    root_metadata = optional_lstat(label, root) if optional else lstat_path(label, root)
    if root_metadata is None:
        return TreeMeasurement(0, 0)
    if stat.S_ISREG(root_metadata.st_mode):
        return TreeMeasurement(root_metadata.st_size, 1)
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise CapacityError(f"{label} has an unexpected file type")

    total_bytes = 0
    total_inodes = 1
    stack: list[Tuple[str, str]] = [(root, label)]
    while stack:
        directory, directory_label = stack.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    entry_label = f"{directory_label}/{entry.name}"
                    try:
                        metadata = entry.stat(follow_symlinks=False)
                    except FileNotFoundError as error:
                        raise CapacityError(f"{entry_label} changed during inspection") from error
                    mode = metadata.st_mode
                    if is_link_or_reparse(metadata):
                        if ignore_links:
                            total_inodes += 1
                            continue
                        raise CapacityError(f"{entry_label} is a symbolic link")
                    if stat.S_ISDIR(mode):
                        total_inodes += 1
                        stack.append((entry.path, entry_label))
                    elif stat.S_ISREG(mode):
                        total_bytes += metadata.st_size
                        total_inodes += 1
                    else:
                        raise CapacityError(f"{entry_label} has an unexpected file type")
        except NotADirectoryError as error:
            raise CapacityError(f"{directory_label} changed during inspection") from error
    return TreeMeasurement(total_bytes, total_inodes)


def measure_node_modules(label: str, release_root: str) -> TreeMeasurement:
    require_directory(label, release_root)
    total = measure_tree(
        f"{label}/node_modules",
        os.path.join(release_root, "node_modules"),
        optional=True,
        ignore_links=True,
    )
    server_root = os.path.join(release_root, "server")
    server_metadata = optional_lstat(f"{label}/server", server_root)
    if server_metadata is None:
        return total
    if not stat.S_ISDIR(server_metadata.st_mode):
        raise CapacityError(f"{label}/server must be a directory")
    return total + measure_tree(
        f"{label}/server/node_modules",
        os.path.join(server_root, "node_modules"),
        optional=True,
        ignore_links=True,
    )


def read_measurement(label: str, path: str) -> TreeMeasurement:
    require_regular_file(label, path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "r", encoding="ascii", closefd=False) as handle:
            raw = handle.read()
    finally:
        os.close(descriptor)
    match = re.fullmatch(r"(0|[1-9][0-9]*):(0|[1-9][0-9]*)\n", raw)
    if not match:
        raise CapacityError(f"{label} has an invalid measurement")
    return TreeMeasurement(int(match.group(1)), int(match.group(2)))


def read_fixture(path: str) -> Mapping[str, TargetObservation]:
    fixture_path = absolute_path(path)
    before = require_regular_file("fixture-json", fixture_path)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(fixture_path, flags)
    except OSError as error:
        raise CapacityError("fixture-json could not be opened without following links") from error
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino
        ):
            raise CapacityError("fixture-json changed before it was opened")
        with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as handle:
            payload = json.load(handle)
        after = os.fstat(descriptor)
        if (
            after.st_dev != opened.st_dev
            or after.st_ino != opened.st_ino
            or after.st_size != opened.st_size
        ):
            raise CapacityError("fixture-json changed while it was read")
    finally:
        os.close(descriptor)

    if not isinstance(payload, dict) or set(payload) != {"contract", "targets"}:
        raise CapacityError("fixture-json has an invalid top-level shape")
    if payload["contract"] != FIXTURE_CONTRACT:
        raise CapacityError("fixture-json has an invalid contract")
    targets = payload["targets"]
    if not isinstance(targets, dict) or set(targets) != set(TARGET_KEYS):
        raise CapacityError("fixture-json must define every target exactly once")

    observations: Dict[str, TargetObservation] = {}
    for target in TARGET_KEYS:
        value = targets[target]
        if not isinstance(value, dict) or set(value) != {
            "st_dev",
            "available_bytes",
            "available_inodes",
        }:
            raise CapacityError(f"fixture-json target {target} has an invalid shape")
        st_dev = value["st_dev"]
        available_bytes = value["available_bytes"]
        available_inodes = value["available_inodes"]
        if (
            isinstance(st_dev, bool)
            or not isinstance(st_dev, int)
            or st_dev < 0
            or isinstance(available_bytes, bool)
            or not isinstance(available_bytes, int)
            or available_bytes < 0
            or isinstance(available_inodes, bool)
            or not isinstance(available_inodes, int)
            or available_inodes < 0
        ):
            raise CapacityError(f"fixture-json target {target} has invalid capacity values")
        observations[target] = TargetObservation(
            st_dev,
            available_bytes,
            available_inodes,
        )
    return observations


def statvfs_available(path: str) -> Tuple[int, int]:
    if not hasattr(os, "statvfs"):
        raise CapacityError("statvfs is unavailable; use --fixture-json for repeatable tests")
    values = os.statvfs(path)
    return values.f_bavail * values.f_frsize, values.f_favail


def existing_target_ancestor(label: str, path: str) -> os.stat_result:
    current = path
    while not os.path.lexists(current):
        parent = os.path.dirname(current)
        if parent == current:
            raise CapacityError(f"{label} has no existing filesystem ancestor")
        current = parent
    return require_directory(f"{label} existing parent", current)


def observe_targets(
    target_paths: Mapping[str, str],
    fixture_path: Optional[str],
) -> Mapping[str, TargetObservation]:
    metadata = {
        "backup-root": require_directory("backup-root", target_paths["backup-root"]),
        "database-path": require_regular_file("database-path", target_paths["database-path"]),
        "live-dir": require_directory("live-dir", target_paths["live-dir"]),
        "parser-state-root": (
            require_directory("parser-state-root", target_paths["parser-state-root"])
            if os.path.lexists(target_paths["parser-state-root"])
            else existing_target_ancestor(
                "parser-state-root", target_paths["parser-state-root"]
            )
        ),
        "ppt-cache-root": (
            require_directory("ppt-cache-root", target_paths["ppt-cache-root"])
            if os.path.lexists(target_paths["ppt-cache-root"])
            else existing_target_ancestor(
                "ppt-cache-root", target_paths["ppt-cache-root"]
            )
        ),
    }
    if fixture_path:
        return read_fixture(fixture_path)
    observations: Dict[str, TargetObservation] = {}
    for target in TARGET_KEYS:
        available_bytes, available_inodes = statvfs_available(
            target_paths[target]
            if os.path.lexists(target_paths[target])
            else os.path.dirname(target_paths[target])
        )
        observations[target] = TargetObservation(
            st_dev=metadata[target].st_dev,
            available_bytes=available_bytes,
            available_inodes=available_inodes,
        )
    return observations


def add_capacity_component(
    devices: Mapping[int, DevicePlan],
    observations: Mapping[str, TargetObservation],
    target: str,
    byte_component: str,
    byte_amount: int,
    inode_component: str,
    inode_amount: int,
) -> None:
    device = devices[observations[target].st_dev]
    device.add_component(byte_component, byte_amount)
    device.add_component(inode_component, inode_amount, inode=True)


def build_report(arguments: argparse.Namespace) -> dict:
    if arguments.mode == "cutover":
        if not arguments.candidate_dir or not arguments.parser_stage or arguments.restore_snapshot:
            raise CapacityError("cutover mode requires candidate-dir and parser-stage only")
    elif not arguments.restore_snapshot or arguments.candidate_dir or arguments.parser_stage:
        raise CapacityError("restore mode requires restore-snapshot only")
    paths = {
        "backup-root": absolute_path(arguments.backup_root),
        "parser-state-root": absolute_path(arguments.parser_state_root),
        "database-path": absolute_path(arguments.database_path),
        "ppt-cache-root": absolute_path(arguments.ppt_cache_root),
        "live-dir": absolute_path(arguments.live_dir),
    }
    if arguments.mode == "cutover":
        paths["candidate-dir"] = absolute_path(arguments.candidate_dir)
        paths["parser-stage"] = absolute_path(arguments.parser_stage)
    else:
        paths["restore-snapshot"] = absolute_path(arguments.restore_snapshot)

    observations = observe_targets(paths, arguments.fixture_json)
    if arguments.mode == "restore":
        restore_snapshot = paths["restore-snapshot"]
        require_directory("restore-snapshot", restore_snapshot)
        expected_snapshot = os.path.join(paths["backup-root"], "cutover-snapshot")
        if os.path.normcase(restore_snapshot) != os.path.normcase(expected_snapshot):
            raise CapacityError("restore-snapshot must be the backup cutover snapshot")
        restore_database = measure_tree(
            "restore-snapshot/database/turingmarket.db",
            os.path.join(restore_snapshot, "database", "turingmarket.db"),
        )
        restore_ppt_cache = measure_tree(
            "restore-snapshot/ppt-cache", os.path.join(restore_snapshot, "ppt-cache")
        )
        restore_parser_runtime = read_measurement(
            "restore-snapshot/parser-appliance/parser-runtime.measurement",
            os.path.join(restore_snapshot, "parser-appliance", "parser-runtime.measurement"),
        )
        restore_root_modules = read_measurement(
            "backup-root/root-node-modules.measurement",
            os.path.join(paths["backup-root"], "root-node-modules.measurement"),
        )
        restore_server_modules = read_measurement(
            "backup-root/server-node-modules.measurement",
            os.path.join(paths["backup-root"], "server-node-modules.measurement"),
        )
        restore_code = measure_tree(
            "backup-root/platform", os.path.join(paths["backup-root"], "platform")
        ) + measure_tree(
            "backup-root/repository", os.path.join(paths["backup-root"], "repository")
        )
        restore_node_modules = restore_root_modules + restore_server_modules

        devices: Dict[int, DevicePlan] = {}
        for target in TARGET_KEYS:
            observation = observations[target]
            if observation.st_dev not in devices:
                devices[observation.st_dev] = DevicePlan(
                    st_dev=observation.st_dev,
                    available_bytes=observation.available_bytes,
                    available_inodes=observation.available_inodes,
                )
            devices[observation.st_dev].add_target(
                target, observation.available_bytes, observation.available_inodes
            )
        for target, prefix, measurement in (
            ("database-path", "restore_database_stage", restore_database),
            ("ppt-cache-root", "restore_ppt_stage", restore_ppt_cache),
            ("parser-state-root", "restore_parser_runtime", restore_parser_runtime),
            ("live-dir", "restore_code", restore_code),
            ("live-dir", "restore_node_modules", restore_node_modules),
        ):
            add_capacity_component(
                devices,
                observations,
                target,
                f"{prefix}_bytes",
                measurement.bytes,
                f"{prefix}_inodes",
                measurement.inodes,
            )
        rendered_devices = [devices[device].render() for device in sorted(devices)]
        return {
            "contract": REPORT_CONTRACT,
            "devices": rendered_devices,
            "measurements": {
                "restore_code_bytes": restore_code.bytes,
                "restore_code_inodes": restore_code.inodes,
                "restore_database_bytes": restore_database.bytes,
                "restore_database_inodes": restore_database.inodes,
                "restore_node_modules_bytes": restore_node_modules.bytes,
                "restore_node_modules_inodes": restore_node_modules.inodes,
                "restore_parser_runtime_bytes": restore_parser_runtime.bytes,
                "restore_parser_runtime_inodes": restore_parser_runtime.inodes,
                "restore_ppt_cache_bytes": restore_ppt_cache.bytes,
                "restore_ppt_cache_inodes": restore_ppt_cache.inodes,
            },
            "mode": "restore",
            "ok": all(device["sufficient"] for device in rendered_devices),
        }

    require_directory("candidate-dir", paths["candidate-dir"])
    require_directory("parser-stage", paths["parser-stage"])

    database = measure_tree("database-path", paths["database-path"])
    ppt_cache = measure_tree(
        "ppt-cache-root", paths["ppt-cache-root"], optional=True
    )
    existing_parser_runtime = measure_tree(
        "parser-state-root/runtime-root",
        os.path.join(paths["parser-state-root"], "runtime-root"),
        optional=True,
    )
    parser_stage = measure_tree("parser-stage", paths["parser-stage"])
    live_node_modules = measure_node_modules("live-dir", paths["live-dir"])
    candidate_node_modules = measure_node_modules(
        "candidate-dir", paths["candidate-dir"]
    )
    rollback_node_modules_bytes = max(
        live_node_modules.bytes - candidate_node_modules.bytes,
        0,
    )
    rollback_node_modules_inodes = max(
        live_node_modules.inodes - candidate_node_modules.inodes,
        0,
    )
    first_install_ppt_cache_inodes = int(
        not os.path.lexists(paths["ppt-cache-root"])
    )

    devices: Dict[int, DevicePlan] = {}
    for target in TARGET_KEYS:
        observation = observations[target]
        if observation.st_dev not in devices:
            devices[observation.st_dev] = DevicePlan(
                st_dev=observation.st_dev,
                available_bytes=observation.available_bytes,
                available_inodes=observation.available_inodes,
            )
        devices[observation.st_dev].add_target(
            target,
            observation.available_bytes,
            observation.available_inodes,
        )

    add_capacity_component(
        devices,
        observations,
        "backup-root",
        "cutover_snapshot_bytes",
        database.bytes + ppt_cache.bytes + existing_parser_runtime.bytes,
        "cutover_snapshot_inodes",
        database.inodes + ppt_cache.inodes + existing_parser_runtime.inodes,
    )
    add_capacity_component(
        devices,
        observations,
        "parser-state-root",
        "parser_install_bytes",
        parser_stage.bytes,
        "parser_install_inodes",
        parser_stage.inodes,
    )
    add_capacity_component(
        devices,
        observations,
        "database-path",
        "rollback_database_stage_bytes",
        database.bytes,
        "rollback_database_stage_inodes",
        database.inodes,
    )
    add_capacity_component(
        devices,
        observations,
        "ppt-cache-root",
        "rollback_ppt_stage_bytes",
        ppt_cache.bytes,
        "rollback_ppt_stage_inodes",
        ppt_cache.inodes,
    )
    devices[observations["ppt-cache-root"].st_dev].add_component(
        "first_install_ppt_cache_inodes",
        first_install_ppt_cache_inodes,
        inode=True,
    )
    add_capacity_component(
        devices,
        observations,
        "live-dir",
        "rollback_node_modules_bytes",
        rollback_node_modules_bytes,
        "rollback_node_modules_inodes",
        rollback_node_modules_inodes,
    )

    rendered_devices = [devices[device].render() for device in sorted(devices)]
    return {
        "contract": REPORT_CONTRACT,
        "devices": rendered_devices,
        "measurements": {
            "candidate_node_modules_bytes": candidate_node_modules.bytes,
            "candidate_node_modules_inodes": candidate_node_modules.inodes,
            "database_bytes": database.bytes,
            "database_inodes": database.inodes,
            "existing_parser_runtime_bytes": existing_parser_runtime.bytes,
            "existing_parser_runtime_inodes": existing_parser_runtime.inodes,
            "live_node_modules_bytes": live_node_modules.bytes,
            "live_node_modules_inodes": live_node_modules.inodes,
            "parser_stage_bytes": parser_stage.bytes,
            "parser_stage_inodes": parser_stage.inodes,
            "ppt_cache_bytes": ppt_cache.bytes,
            "ppt_cache_inodes": ppt_cache.inodes,
        },
        "mode": "cutover",
        "ok": all(device["sufficient"] for device in rendered_devices),
    }


def stable_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def run(argv: Optional[Sequence[str]] = None) -> int:
    try:
        report = build_report(parse_arguments(argv))
    except (CapacityError, OSError, UnicodeError, ValueError, OverflowError) as error:
        print(f"cutover capacity check failed: {error}", file=sys.stderr)
        return 2
    print(stable_json(report))
    if not report["ok"]:
        print(f"insufficient {report['mode']} capacity", file=sys.stderr)
        return 1
    print("RESTORE_CAPACITY_OK" if report["mode"] == "restore" else "CUTOVER_CAPACITY_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
