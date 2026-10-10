// Local protocol smoke fixture: real OmniCloud services, simulated remote adapter.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
const dir = await mkdtemp(path.join(os.tmpdir(), 's3-smoke-'));
process.env.OMNICLOUD_SECRET_HALF = 'isolated-s3-test-encryption-secret-32-bytes';
process.env.DATABASE_PATH = path.join(dir, 'db');
process.env.FILE_CACHE_PATH = path.join(dir, 'cache');
process.env.S3_MULTIPART_PATH = path.join(dir, 'parts');
process.env.S3_GATEWAY_ENABLED = 'true';
process.env.APP_MODE = 'local';
const { db, LOCAL_USER_ID } = await import('../../src/config/database.js');
const { createCredential, setEnabled } = await import('../../src/s3/credentials.js');
const { BaseCloudAdapter } = await import('../../src/adapters/BaseCloudAdapter.js');
const { createApp } = await import('../../src/app.js');
const files = new Map();
BaseCloudAdapter.prototype.uploadStream = async function ({
	stream,
	fileName,
	virtualPath,
	mimeType,
}) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	const id = randomUUID();
	files.set(id, { body: Buffer.concat(chunks), name: fileName, path: virtualPath, mimeType });
	return { remoteFileId: id };
};
BaseCloudAdapter.prototype.renameFile = async function (file, name) {
	files.get(file.remote_file_id).name = name;
	return { remoteFileId: file.remote_file_id };
};
BaseCloudAdapter.prototype.deleteFile = async function (file) {
	files.delete(file.remote_file_id);
};
BaseCloudAdapter.prototype.getDownloadStream = async function (file) {
	return Readable.from([files.get(file.remote_file_id).body]);
};
BaseCloudAdapter.prototype.createFolder = async function () {
	return { remoteFileId: randomUUID() };
};
db.prepare(
	"INSERT INTO cloud_accounts(id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES ('smoke',?,'smoke@test.invalid','base','x',1099511627776,0,'active')",
).run(LOCAL_USER_ID);
setEnabled(LOCAL_USER_ID, true);
const credentials = createCredential(LOCAL_USER_ID);
const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
await writeFile(
	process.argv[2],
	JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, ...credentials }),
	{ mode: 0o600 },
);
console.info(
	'Smoke fixture ready (isolated SQLite and simulated remote; credentials saved privately).',
);
async function stop() {
	await new Promise((resolve) => server.close(resolve));
	db.close();
	await rm(dir, { recursive: true, force: true });
	process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
