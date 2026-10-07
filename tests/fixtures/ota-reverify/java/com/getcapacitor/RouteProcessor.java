package com.getcapacitor;

public interface RouteProcessor {
    ProcessedRoute process(String basePath, String path);
}
