import fs from 'node:fs/promises';
import path from 'node:path';

// LibreOffice headless compartilha estado no perfil do usuario: um perfil por
// conversao evita corrida entre processos simultaneos.
export async function officeToPdf({ execute, inputPath, outDir, timeoutMs }) {
	await execute('libreoffice', [
		`-env:UserInstallation=file://${path.join(outDir, 'profile')}`,
		'--headless',
		'--convert-to', 'pdf',
		'--outdir', outDir,
		inputPath,
	], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });

	return path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
}

export async function writeStreamToFile(stream, targetPath, maxBytes) {
	const handle = await fs.open(targetPath, 'w');
	let bytes = 0;
	try {
		for await (const chunk of stream) {
			bytes += Buffer.byteLength(chunk);
			if (bytes > maxBytes) {
				const error = new Error('File is too large');
				error.statusCode = 415;
				throw error;
			}
			await handle.write(chunk);
		}
	} finally {
		await handle.close();
	}
}
