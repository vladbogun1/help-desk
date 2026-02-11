package com.example.helpdesk.service;

import com.example.helpdesk.util.FileUtils;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class FileUtilsTest {
  @Test
  void detectsBinaryAndText() throws Exception {
    Path txt = Files.createTempFile("txt", ".txt");
    Files.writeString(txt, "hello");
    assertFalse(FileUtils.isBinary(txt));

    Path bin = Files.createTempFile("bin", ".bin");
    Files.write(bin, new byte[]{1, 2, 0, 3});
    assertTrue(FileUtils.isBinary(bin));
  }
}
