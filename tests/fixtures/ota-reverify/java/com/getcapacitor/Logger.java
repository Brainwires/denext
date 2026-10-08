package com.getcapacitor;

public final class Logger {
    public static void warn(String message) {
        System.err.println("W " + message);
    }

    public static void debug(String message) {}

    public static void info(String message) {}

    public static void error(String message) {
        System.err.println("E " + message);
    }

    public static void error(String message, Throwable error) {
        System.err.println("E " + message + ": " + error);
    }
}
