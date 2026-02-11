package com.example.helpdesk.service;

import com.example.helpdesk.config.AppProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import org.springframework.stereotype.Component;

@Component
public class V8UnpackService {
  private final AppProperties props;

  public V8UnpackService(AppProperties props) { this.props = props; }

  public boolean dump(Path cfFile, Path dumpDir) throws IOException, InterruptedException {
    Files.createDirectories(dumpDir);
    Path tool = Path.of(props.v8unpackPath());
    if (!Files.exists(tool)) return false;
    Process p = new ProcessBuilder(tool.toString(), "-P", cfFile.toString(), dumpDir.toString()).start();
    return p.waitFor() == 0;
  }

  public void normalize(Path dir) throws IOException {
    if (!Files.exists(dir)) return;
    try (var walk = Files.walk(dir)) {
      walk.filter(Files::isRegularFile).sorted(Comparator.comparing(Path::toString)).forEach(path -> {
        try {
          byte[] data = Files.readAllBytes(path);
          String txt = new String(data);
          txt = txt.replace("\r\n", "\n").replace("\r", "\n");
          if (txt.startsWith("\uFEFF")) txt = txt.substring(1);
          Files.writeString(path, txt);
        } catch (Exception ignored) {}
      });
    }
  }
}
