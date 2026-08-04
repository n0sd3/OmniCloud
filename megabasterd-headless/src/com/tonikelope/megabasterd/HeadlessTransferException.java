package com.tonikelope.megabasterd;

public final class HeadlessTransferException extends Exception {

    public enum Code {
        INVALID_INPUT, NOT_FOUND, QUOTA, UPSTREAM, CANCELLED
    }

    private final Code code;

    HeadlessTransferException(Code code, String message) {
        super(message);
        this.code = code;
    }

    HeadlessTransferException(Code code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public Code getCode() {
        return code;
    }
}
