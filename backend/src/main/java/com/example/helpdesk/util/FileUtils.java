package com.example.helpdesk.util;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

public final class FileUtils {
  private FileUtils() {}

  public static String sha256(Path path) throws IOException {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      md.update(Files.readAllBytes(path));
      return HexFormat.of().formatHex(md.digest());
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  public static boolean isBinary(Path path) throws IOException {
    byte[] data = Files.readAllBytes(path);
    for (byte b : data) if (b == 0) return true;
    try {
      StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(data));
      return false;
    } catch (CharacterCodingException e) {
      return true;
    }
  }

  public static String normalizeText(Path path) throws IOException {
    byte[] bytes = Files.readAllBytes(path);
    String text = new String(bytes, StandardCharsets.UTF_8);
    if (text.startsWith("\uFEFF")) text = text.substring(1);
    return text.replace("\r\n", "\n").replace("\r", "\n");
  }
}
