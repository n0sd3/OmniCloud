package com.tonikelope.megabasterd;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import javax.crypto.Cipher;
import javax.crypto.CipherInputStream;

public final class HeadlessTransfer {

    private static final int TIMEOUT_MS = 15_000;
    private static final int BUFFER_SIZE = 16_384;
    private final MegaApiFactory megaApiFactory;

    public HeadlessTransfer(MegaApiFactory megaApiFactory) {
        if (megaApiFactory == null) {
            throw new IllegalArgumentException("megaApiFactory is required");
        }
        this.megaApiFactory = megaApiFactory;
    }

    public PublicMetadata inspectPublic(String link) throws HeadlessTransferException {
        String legacyLink = legacyLink(link);
        try {
            MegaAPI megaApi = megaApiFactory.create();
            if (megaApi == null) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "MEGA API is unavailable");
            }
            String[] metadata = megaApi.getMegaFileMetadata(legacyLink);
            if (metadata == null || metadata.length < 3) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "MEGA metadata is incomplete");
            }
            return new PublicMetadata(megaApi.getMegaFileDownloadUrl(legacyLink), metadata[2], metadata[0], parseSize(metadata[1]));
        } catch (HeadlessTransferException error) {
            throw error;
        } catch (MegaAPIException error) {
            throw apiError(error);
        } catch (Exception error) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "Unable to inspect MEGA link", error);
        }
    }

    public void streamPublic(String link, ByteRange range, OutputStream output) throws HeadlessTransferException {
        PublicMetadata metadata = inspectPublic(link);
        streamResolved(new ResolvedTransfer(metadata.downloadUrl, metadata.fileKey, metadata.fileName, metadata.size), range, output);
    }

    public void streamResolved(ResolvedTransfer transfer, ByteRange range, OutputStream output) throws HeadlessTransferException {
        if (transfer == null || output == null) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.INVALID_INPUT, "transfer and output are required");
        }
        if (transfer.size == 0 && range == null) {
            return;
        }

        long requestedStart = range == null ? 0 : range.start;
        long requestedEnd = range == null || range.end == null ? transfer.size - 1 : range.end;
        if (requestedStart >= transfer.size || requestedEnd < requestedStart || requestedEnd >= transfer.size) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.INVALID_INPUT, "range is outside the file");
        }

        long alignedStart = requestedStart - (requestedStart % 16);
        int skip = (int) (requestedStart - alignedStart);
        HttpURLConnection connection = null;
        try {
            URL source = new URL(transfer.downloadUrl + "/" + alignedStart + "-" + requestedEnd);
            connection = (HttpURLConnection) source.openConnection();
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestMethod("GET");
            int status = connection.getResponseCode();
            if (status == 509) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.QUOTA, "MEGA transfer quota exceeded");
            }
            if (status == 404) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.NOT_FOUND, "MEGA transfer was not found");
            }
            if (status != HttpURLConnection.HTTP_OK) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "MEGA source returned HTTP " + status);
            }

            Cipher cipher = CryptTools.genDecrypter(
                    "AES", "AES/CTR/NoPadding",
                    CryptTools.initMEGALinkKey(transfer.fileKey),
                    alignedStart == 0
                            ? CryptTools.initMEGALinkKeyIV(transfer.fileKey)
                            : CryptTools.forwardMEGALinkKeyIV(CryptTools.initMEGALinkKeyIV(transfer.fileKey), alignedStart));
            try (InputStream encrypted = connection.getInputStream(); CipherInputStream decrypted = new CipherInputStream(encrypted, cipher)) {
                skipExactly(decrypted, skip);
                copyExactly(decrypted, output, requestedEnd - requestedStart + 1);
            }
        } catch (CopyCancelled error) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.CANCELLED, "Output stream closed", error);
        } catch (HeadlessTransferException error) {
            throw error;
        } catch (IOException error) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "Unable to stream MEGA file", error);
        } catch (Exception error) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "Unable to decrypt MEGA file", error);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String legacyLink(String link) throws HeadlessTransferException {
        if (link == null || link.trim().isEmpty()) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.INVALID_INPUT, "MEGA link is required");
        }
        return MiscTools.newMegaLinks2Legacy(link).trim();
    }

    private static long parseSize(String size) throws HeadlessTransferException {
        try {
            long parsed = Long.parseLong(size);
            if (parsed < 0) {
                throw new NumberFormatException("negative size");
            }
            return parsed;
        } catch (RuntimeException error) {
            throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "MEGA metadata has an invalid size", error);
        }
    }

    private static HeadlessTransferException apiError(MegaAPIException error) {
        return new HeadlessTransferException(error.getCode() == -9
                ? HeadlessTransferException.Code.NOT_FOUND
                : HeadlessTransferException.Code.UPSTREAM, "MEGA API request failed", error);
    }

    private static void skipExactly(InputStream input, int bytes) throws IOException, HeadlessTransferException {
        while (bytes > 0) {
            int skipped = input.read();
            if (skipped < 0) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "MEGA source ended before range start");
            }
            bytes--;
        }
    }

    private static void copyExactly(InputStream input, OutputStream output, long bytes) throws IOException, CopyCancelled, HeadlessTransferException {
        byte[] buffer = new byte[BUFFER_SIZE];
        while (bytes > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, bytes));
            if (read < 0) {
                throw new HeadlessTransferException(HeadlessTransferException.Code.UPSTREAM, "MEGA source ended before range end");
            }
            try {
                output.write(buffer, 0, read);
            } catch (IOException error) {
                throw new CopyCancelled(error);
            }
            bytes -= read;
        }
    }

    @FunctionalInterface
    public interface MegaApiFactory {
        MegaAPI create();
    }

    public static final class ByteRange {
        public final long start;
        public final Long end;

        public ByteRange(long start, Long end) {
            if (start < 0 || end != null && end < start) {
                throw new IllegalArgumentException("invalid inclusive byte range");
            }
            this.start = start;
            this.end = end;
        }
    }

    public static final class ResolvedTransfer {
        public final String downloadUrl;
        public final String fileKey;
        public final String fileName;
        public final long size;

        public ResolvedTransfer(String downloadUrl, String fileKey, String fileName, long size) {
            if (blank(downloadUrl) || blank(fileKey) || blank(fileName) || size < 0) {
                throw new IllegalArgumentException("invalid resolved transfer");
            }
            this.downloadUrl = downloadUrl;
            this.fileKey = fileKey;
            this.fileName = fileName;
            this.size = size;
        }
    }

    public static final class PublicMetadata {
        public final String downloadUrl;
        public final String fileKey;
        public final String fileName;
        public final long size;

        private PublicMetadata(String downloadUrl, String fileKey, String fileName, long size) {
            if (blank(downloadUrl) || blank(fileKey) || blank(fileName) || size < 0) {
                throw new IllegalArgumentException("invalid public metadata");
            }
            this.downloadUrl = downloadUrl;
            this.fileKey = fileKey;
            this.fileName = fileName;
            this.size = size;
        }
    }

    private static boolean blank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private static final class CopyCancelled extends Exception {
        private CopyCancelled(IOException cause) {
            super(cause);
        }
    }
}

final class HeadlessTransferException extends Exception {

    enum Code {
        INVALID_INPUT, NOT_FOUND, QUOTA, UPSTREAM, CANCELLED
    }

    final Code code;

    HeadlessTransferException(Code code, String message) {
        super(message);
        this.code = code;
    }

    HeadlessTransferException(Code code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    Code getCode() {
        return code;
    }
}
