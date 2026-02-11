package com.example.helpdesk.service;

import com.example.helpdesk.domain.Models.ChangeType;
import com.example.helpdesk.domain.Models.ChangedFile;
import com.example.helpdesk.domain.Models.FileDelta;
import com.example.helpdesk.domain.Models.MetadataObject;
import com.example.helpdesk.domain.Models.ObjectStatus;
import com.example.helpdesk.domain.Models.Presence;
import com.example.helpdesk.util.FileUtils;
import com.github.difflib.DiffUtils;
import com.github.difflib.UnifiedDiffUtils;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

@Component
public class CompareEngine {
  public record CompareResult(List<MetadataObject> objects, Map<String, FileDelta> deltas, Map<String, Long> leftSummary, Map<String, Long> rightSummary, Map<String, Long> diffSummary) {}

  public CompareResult compare(Path leftDump, Path rightDump) throws IOException {
    Map<String, Path> leftFiles = listFiles(leftDump);
    Map<String, Path> rightFiles = listFiles(rightDump);
    Set<String> all = new java.util.TreeSet<>();
    all.addAll(leftFiles.keySet());
    all.addAll(rightFiles.keySet());

    Map<String, FileDelta> deltas = new TreeMap<>();
    Map<String, List<FileDelta>> byObject = new HashMap<>();

    for (String rel : all) {
      Path l = leftFiles.get(rel);
      Path r = rightFiles.get(rel);
      FileDelta delta;
      if (l == null) {
        delta = new FileDelta(rel, ChangeType.ADDED, null, FileUtils.sha256(r), FileUtils.isBinary(r), null, r);
      } else if (r == null) {
        delta = new FileDelta(rel, ChangeType.REMOVED, FileUtils.sha256(l), null, FileUtils.isBinary(l), l, null);
      } else {
        String lh = FileUtils.sha256(l);
        String rh = FileUtils.sha256(r);
        ChangeType t = lh.equals(rh) ? ChangeType.UNCHANGED : ChangeType.CHANGED;
        boolean bin = FileUtils.isBinary(l) || FileUtils.isBinary(r);
        delta = new FileDelta(rel, t, lh, rh, bin, l, r);
      }
      deltas.put(rel, delta);
      byObject.computeIfAbsent(objectKey(rel), x -> new ArrayList<>()).add(delta);
    }

    List<MetadataObject> objects = byObject.entrySet().stream().map(e -> toObject(e.getKey(), e.getValue())).sorted(java.util.Comparator.comparing(MetadataObject::type).thenComparing(MetadataObject::name)).toList();

    return new CompareResult(objects, deltas, summarizeObjects(objects, true), summarizeObjects(objects, false), summarizeDiff(objects));
  }

  private MetadataObject toObject(String key, List<FileDelta> deltas) {
    String[] split = key.split("::", 3);
    String type = split[0];
    String name = split[1];
    String path = split[2];

    boolean hasLeft = deltas.stream().anyMatch(d -> d.leftPath() != null);
    boolean hasRight = deltas.stream().anyMatch(d -> d.rightPath() != null);
    Presence presence = hasLeft && hasRight ? Presence.BOTH : hasLeft ? Presence.LEFT_ONLY : Presence.RIGHT_ONLY;

    ObjectStatus status = ObjectStatus.UNCHANGED;
    if (deltas.stream().anyMatch(d -> d.type() == ChangeType.CHANGED)) status = ObjectStatus.CHANGED;
    else if (!hasLeft) status = ObjectStatus.ADDED;
    else if (!hasRight) status = ObjectStatus.REMOVED;

    List<ChangedFile> changed = deltas.stream().filter(d -> d.type() != ChangeType.UNCHANGED)
        .map(d -> new ChangedFile(d.path(), d.type(), d.leftHash(), d.rightHash(), d.binary())).toList();

    String id = type + ":" + name + ":" + path;
    return new MetadataObject(id, type, name, path, presence, status, changed);
  }

  private Map<String, Long> summarizeObjects(List<MetadataObject> objects, boolean left) {
    return objects.stream()
        .filter(o -> left ? o.sidePresence() != Presence.RIGHT_ONLY : o.sidePresence() != Presence.LEFT_ONLY)
        .collect(Collectors.groupingBy(MetadataObject::type, TreeMap::new, Collectors.counting()));
  }

  private Map<String, Long> summarizeDiff(List<MetadataObject> objects) {
    return Map.of(
        "added", objects.stream().filter(o -> o.status() == ObjectStatus.ADDED).count(),
        "removed", objects.stream().filter(o -> o.status() == ObjectStatus.REMOVED).count(),
        "changed", objects.stream().filter(o -> o.status() == ObjectStatus.CHANGED).count(),
        "unchanged", objects.stream().filter(o -> o.status() == ObjectStatus.UNCHANGED).count()
    );
  }

  private String objectKey(String relPath) {
    String[] seg = relPath.split("/");
    String type = seg.length > 0 ? seg[0].toUpperCase() : "ROOT";
    String name = seg.length > 1 ? seg[1] : "ROOT";
    String path = seg.length > 1 ? seg[0] + "/" + seg[1] : relPath;
    return type + "::" + name + "::" + path;
  }

  private Map<String, Path> listFiles(Path root) throws IOException {
    Map<String, Path> m = new TreeMap<>();
    if (!Files.exists(root)) return m;
    try (var walk = Files.walk(root)) {
      walk.filter(Files::isRegularFile).forEach(p -> m.put(root.relativize(p).toString().replace('\\', '/'), p));
    }
    return m;
  }

  public Map<String, Object> diff(FileDelta delta) throws IOException {
    if (delta.binary()) {
      return Map.of("path", delta.path(), "isBinary", true, "diff", null, "leftHash", delta.leftHash(), "rightHash", delta.rightHash());
    }
    List<String> left = delta.leftPath() == null ? List.of() : List.of(FileUtils.normalizeText(delta.leftPath()).split("\n", -1));
    List<String> right = delta.rightPath() == null ? List.of() : List.of(FileUtils.normalizeText(delta.rightPath()).split("\n", -1));
    var patch = DiffUtils.diff(left, right);
    var unified = UnifiedDiffUtils.generateUnifiedDiff("left/" + delta.path(), "right/" + delta.path(), left, patch, 3);
    return Map.of("path", delta.path(), "isBinary", false, "diff", String.join("\n", unified));
  }
}
