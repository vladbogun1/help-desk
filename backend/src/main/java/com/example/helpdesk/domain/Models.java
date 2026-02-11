package com.example.helpdesk.domain;

import java.time.Instant;
import java.util.List;
import java.util.Map;

public class Models {
  public enum JobStatus { QUEUED, RUNNING, DONE, FAILED }
  public enum ObjectStatus { ADDED, REMOVED, CHANGED, UNCHANGED }
  public enum Presence { LEFT_ONLY, RIGHT_ONLY, BOTH }
  public enum ChangeType { ADDED, REMOVED, CHANGED, UNCHANGED }

  public record CompareJob(
      String id,
      JobStatus status,
      Instant createdAt,
      Instant finishedAt,
      int progress,
      String stage,
      Map<String, Long> leftMetaSummary,
      Map<String, Long> rightMetaSummary,
      Map<String, Long> diffSummary,
      String error
  ) {}

  public record ChangedFile(String path, ChangeType changeType, String leftHash, String rightHash, boolean isBinary) {}

  public record MetadataObject(
      String id,
      String type,
      String name,
      String path,
      Presence sidePresence,
      ObjectStatus status,
      List<ChangedFile> changedFiles
  ) {}

  public record JobData(
      CompareJob job,
      List<MetadataObject> objects,
      Map<String, FileDelta> fileDeltas
  ) {}

  public record FileDelta(String path, ChangeType type, String leftHash, String rightHash, boolean binary, java.nio.file.Path leftPath, java.nio.file.Path rightPath) {}
}
