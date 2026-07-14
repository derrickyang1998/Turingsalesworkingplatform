# Phase 3 Accessibility Residual Risks / 第三阶段无障碍剩余风险

## Evidence Boundary / 证据边界

- NVDA and VoiceOver were not available and were not executed. They are not recorded as passed. / 本轮无法使用且未执行 NVDA 与 VoiceOver，不将其记录为通过。
- Browser-native zoom was not automated and was not recorded as passed. / 未自动化验证浏览器原生缩放，不将其记录为通过。
- The `200%` and `400%` checks cover CSS viewport reflow equivalence only; they do not substitute for browser-native zoom. / `200%` 与 `400%` 校验仅覆盖 CSS 视口回流等效场景，不等同于浏览器原生缩放。
- Representative axe, keyboard, focus-trap, reduced-motion, forced-colors, and responsive browser checks passed. This is not a full WCAG conformance claim. / 代表性的 axe、键盘、焦点限制、减少动画、强制色彩和响应式浏览器检查已通过，但这不是完整 WCAG 符合性声明。

## Deferred Work / 延后工作

- Full keyboard connection authoring in the legacy workflow designer is deferred to Phase 4. The Phase 3 acceptance boundary covers keyboard node creation and selection only. / 旧流程设计器的完整键盘连线创作延后至第 4 阶段；第 3 阶段验收仅覆盖键盘创建与选择节点。
- Phase 4 owns assistive-technology checks for the workflow composition changes and must re-run the shared dialog, focus, and reflow gates. / 第 4 阶段负责流程构成变化的辅助技术检查，并须重跑共享弹窗、焦点与回流门禁。

## Acceptance / 验收

Phase 3 may ship only when its automated contracts and representative browser matrix pass, while the unexecuted checks above remain explicit residual risks rather than implied passes. / 第 3 阶段仅在自动化契约与代表性浏览器矩阵通过后方可发布；上述未执行项目必须继续作为明确剩余风险，不能表述为已通过。
