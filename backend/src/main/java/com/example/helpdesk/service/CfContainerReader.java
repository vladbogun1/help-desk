package com.example.helpdesk.service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;
import org.springframework.stereotype.Component;

@Component
public class CfContainerReader {
  public void unpack(Path cfFile, Path outputDir) throws IOException {
    Files.createDirectories(outputDir);
    Path copyPath = outputDir.resolve("container.cf");
    Files.copy(cfFile, copyPath);
    tryRawDeflate(cfFile, outputDir.resolve("container.raw.inflate"));
  }

  private void tryRawDeflate(Path input, Path out) {
    try (InputStream is = Files.newInputStream(input);
         InflaterInputStream inflater = new InflaterInputStream(is, new Inflater(true))) {
      Files.copy(inflater, out);
    } catch (Exception ignored) {
      // best-effort fallback for raw-deflate streams
    }
  }
}
