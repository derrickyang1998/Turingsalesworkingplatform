const test = require('node:test');
const assert = require('node:assert/strict');

const fileIngestService = require('../services/file_ingest_service');

test('normalizes read-excel-file sheet objects into table rows', () => {
  const rows = fileIngestService.normalizeXlsxRows([{
    sheet: 'Sheet1',
    data: [
      ['日期', '网红频道名称', 'CPV(自动计算)'],
      ['2026-07-03', '@custom_kol', 0.04]
    ]
  }]);

  assert.deepEqual(rows, [{
    '日期': '2026-07-03',
    '网红频道名称': '@custom_kol',
    'CPV(自动计算)': 0.04
  }]);
});
