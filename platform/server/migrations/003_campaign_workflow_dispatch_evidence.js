const COLUMN_DEFINITION = "template_label TEXT NOT NULL DEFAULT 'Workflow template' CHECK(length(template_label) BETWEEN 1 AND 1000)";

const TEMPLATE_LABEL_TRIGGER = `CREATE TRIGGER campaign_workflow_dispatches_template_label_immutable
BEFORE UPDATE OF template_label ON campaign_workflow_dispatches
WHEN NEW.template_label IS NOT OLD.template_label
BEGIN
  SELECT RAISE(ABORT,'campaign workflow template label is immutable');
END`;

const migration = {
  version: 3,
  name: '003_campaign_workflow_dispatch_evidence',
  sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      campaign_workflow_dispatches: {
        template_label: {
          type: 'TEXT',
          notnull: 1,
          defaultValue: "'Workflow template'"
        }
      }
    },
    indexes: {},
    triggers: {
      campaign_workflow_dispatches_template_label_immutable: TEMPLATE_LABEL_TRIGGER
    },
    tableChecks: {
      campaign_workflow_dispatches: [
        'CHECK(length(template_label) BETWEEN 1 AND 1000)'
      ]
    }
  },
  apply(db) {
    const table = db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type='table' AND name='campaign_workflow_dispatches'
    `).get();
    if (!table) throw new Error('003 requires campaign_workflow_dispatches');
    const columns = db.prepare('PRAGMA table_xinfo("campaign_workflow_dispatches")').all();
    if (columns.some((column) => column.name === 'template_label')) {
      throw new Error('partial 003 template_label column exists');
    }
    const trigger = db.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type='trigger' AND name='campaign_workflow_dispatches_template_label_immutable'
    `).get();
    if (trigger) throw new Error('partial 003 template label trigger exists');
    const legalTransition = db.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE type='trigger' AND name='campaign_workflow_dispatches_legal_transition'
    `).get();
    if (!legalTransition || typeof legalTransition.sql !== 'string') {
      throw new Error('003 requires the v2 dispatch transition trigger');
    }

    db.exec(`
      DROP TRIGGER campaign_workflow_dispatches_legal_transition;
      ALTER TABLE campaign_workflow_dispatches ADD COLUMN ${COLUMN_DEFINITION};

      UPDATE campaign_workflow_dispatches AS dispatch
      SET template_label = COALESCE((
        SELECT CASE
          WHEN typeof(template.name)='text'
            AND length(template.name) BETWEEN 1 AND 1000
            AND length(trim(template.name)) > 0
            AND instr(template.name,char(0)) = 0
          THEN template.name
          ELSE 'Workflow template #' || CAST(dispatch.template_id AS TEXT)
        END
        FROM workflow_templates AS template
        WHERE template.id=dispatch.template_id
      ), 'Workflow template #' || CAST(dispatch.template_id AS TEXT));

      ${legalTransition.sql};
      ${TEMPLATE_LABEL_TRIGGER};
    `);
  }
};

module.exports = migration;
