package com.example.helpdesk.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(String workspaceRoot, long jobTtlMinutes, String v8unpackPath) {}
