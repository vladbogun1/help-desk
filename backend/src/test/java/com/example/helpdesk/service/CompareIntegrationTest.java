package com.example.helpdesk.service;

import org.junit.jupiter.api.Test;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

class CompareIntegrationTest {
  @Test
  void generatesUnifiedDiff() throws Exception {
    Path l = Files.createTempDirectory("l");
    Path r = Files.createTempDirectory("r");
    Files.createDirectories(l.resolve("Documents/Doc1"));
    Files.createDirectories(r.resolve("Documents/Doc1"));
    Files.writeString(l.resolve("Documents/Doc1/body.txt"), "line1\nline2");
    Files.writeString(r.resolve("Documents/Doc1/body.txt"), "line1\nlineX");

    CompareEngine engine = new CompareEngine();
    var cmp = engine.compare(l, r);
    var delta = cmp.deltas().get("Documents/Doc1/body.txt");
    var diff = engine.diff(delta);
    assertEquals(false, diff.get("isBinary"));
    assertTrue(diff.get("diff").toString().contains("@@"));
  }
}
