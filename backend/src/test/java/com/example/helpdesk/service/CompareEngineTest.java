package com.example.helpdesk.service;

import com.example.helpdesk.domain.Models.ObjectStatus;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CompareEngineTest {
  @Test
  void comparesDirectories() throws Exception {
    Path l = Files.createTempDirectory("l");
    Path r = Files.createTempDirectory("r");
    Files.createDirectories(l.resolve("Catalogs/Customers"));
    Files.createDirectories(r.resolve("Catalogs/Customers"));
    Files.writeString(l.resolve("Catalogs/Customers/a.xml"), "x");
    Files.writeString(r.resolve("Catalogs/Customers/a.xml"), "y");

    CompareEngine engine = new CompareEngine();
    var result = engine.compare(l, r);
    assertEquals(1, result.objects().size());
    assertEquals(ObjectStatus.CHANGED, result.objects().getFirst().status());
  }
}
