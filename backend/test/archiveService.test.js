import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnzipList } from '../src/services/archiveService.js';

const UNZIP_OUTPUT = `Archive:  sample.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      612  2026-07-01 10:12   readme.md
        0  2026-07-01 10:12   docs/
    10240  2026-07-01 10:13   docs/manual with spaces.pdf
---------                     -------
    10852                     3 files`;

test('parseUnzipList reads name and size, keeping spaces in names', () => {
	const entries = parseUnzipList(UNZIP_OUTPUT);

	assert.deepEqual(entries, [
		{ name: 'readme.md', size: 612 },
		{ name: 'docs/', size: 0 },
		{ name: 'docs/manual with spaces.pdf', size: 10240 },
	]);
});

test('parseUnzipList returns nothing for output without a table', () => {
	assert.deepEqual(parseUnzipList('cannot find zipfile directory'), []);
});
