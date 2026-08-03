import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GOOGLE_CLIENT_ID = 'google-client-id-for-test';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret-for-test';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/accounts/google/callback';

const { createGoogleAuthorizationRequest } = await import('../src/services/googleOAuthService.js');
const { GoogleDriveAdapter } = await import('../src/adapters/GoogleDriveAdapter.js');

test('Google authorization asks for Picker access together with Drive access', () => {
	const { authorizationUrl } = createGoogleAuthorizationRequest('user-1');
	const scope = new URL(authorizationUrl).searchParams.get('scope').split(' ');

	assert.ok(scope.includes('https://www.googleapis.com/auth/drive'));
	assert.ok(scope.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly'));
});

test('Drive adapter returns every name in the resolved destination folder', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	adapter.getDriveClient = async () => ({
		files: { list: async () => ({ data: { files: [{ name: 'foto.jpg' }, { name: 'video.mp4' }] } }) },
	});

	assert.deepEqual(await adapter.listFileNames('folder-1'), ['foto.jpg', 'video.mp4']);
});
