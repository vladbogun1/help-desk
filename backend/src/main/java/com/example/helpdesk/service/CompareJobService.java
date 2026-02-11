package com.example.helpdesk.service;

import com.example.helpdesk.config.AppProperties;
import com.example.helpdesk.domain.Models.CompareJob;
import com.example.helpdesk.domain.Models.JobData;
import com.example.helpdesk.domain.Models.JobStatus;
import com.example.helpdesk.domain.Models.MetadataObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

@Service
public class CompareJobService {
  private final AppProperties props;
  private final CfContainerReader reader;
  private final V8UnpackService unpack;
  private final CompareEngine engine;
  private final ExecutorService executor = Executors.newFixedThreadPool(2);
  private final Map<String, MutableJob> jobs = new ConcurrentHashMap<>();

  public CompareJobService(AppProperties props, CfContainerReader reader, V8UnpackService unpack, CompareEngine engine) {
    this.props = props;
    this.reader = reader;
    this.unpack = unpack;
    this.engine = engine;
  }

  public String create(MultipartFile left, MultipartFile right) throws IOException {
    String id = UUID.randomUUID().toString();
    Path base = Path.of(props.workspaceRoot(), id);
    Files.createDirectories(base.resolve("input"));
    Path leftPath = base.resolve("input/left.cf");
    Path rightPath = base.resolve("input/right.cf");
    left.transferTo(leftPath);
    right.transferTo(rightPath);

    MutableJob job = MutableJob.queued(id, base);
    jobs.put(id, job);
    CompletableFuture.runAsync(() -> run(job, leftPath, rightPath), executor);
    return id;
  }

  private void run(MutableJob m, Path leftCf, Path rightCf) {
    try {
      m.update(5, "Unpacking raw container", JobStatus.RUNNING, null);
      Path rawLeft = m.base.resolve("raw/left");
      Path rawRight = m.base.resolve("raw/right");
      reader.unpack(leftCf, rawLeft);
      reader.unpack(rightCf, rawRight);

      m.update(35, "Running v8unpack", JobStatus.RUNNING, null);
      Path dumpLeft = m.base.resolve("dump/left");
      Path dumpRight = m.base.resolve("dump/right");
      boolean okLeft = unpack.dump(leftCf, dumpLeft);
      boolean okRight = unpack.dump(rightCf, dumpRight);
      if (!(okLeft && okRight)) {
        Files.createDirectories(dumpLeft);
        Files.createDirectories(dumpRight);
        copyAll(rawLeft, dumpLeft);
        copyAll(rawRight, dumpRight);
      }
      unpack.normalize(dumpLeft);
      unpack.normalize(dumpRight);

      m.update(70, "Comparing metadata and files", JobStatus.RUNNING, null);
      var result = engine.compare(dumpLeft, dumpRight);

      m.data = new JobData(m.toJob(JobStatus.DONE, 100, "Done", null, result.leftSummary(), result.rightSummary(), result.diffSummary()), result.objects(), result.deltas());
      m.finished = Instant.now();
    } catch (Exception e) {
      m.data = new JobData(m.toJob(JobStatus.FAILED, m.progress, m.stage, e.getMessage(), Map.of(), Map.of(), Map.of()), List.of(), Map.of());
      m.finished = Instant.now();
    }
  }

  private void copyAll(Path from, Path to) throws IOException {
    try (var walk = Files.walk(from)) {
      walk.forEach(src -> {
        try {
          Path dest = to.resolve(from.relativize(src).toString());
          if (Files.isDirectory(src)) Files.createDirectories(dest);
          else Files.copy(src, dest);
        } catch (IOException e) { throw new RuntimeException(e); }
      });
    }
  }

  public CompareJob job(String id) {
    return get(id).data.job();
  }

  public List<MetadataObject> objects(String id, String q, String type, String status, int page, int size) {
    List<MetadataObject> all = get(id).data.objects().stream()
        .filter(o -> q == null || o.name().toLowerCase().contains(q.toLowerCase()))
        .filter(o -> type == null || o.type().equalsIgnoreCase(type))
        .filter(o -> status == null || o.status().name().equalsIgnoreCase(status))
        .toList();
    int from = Math.min(page * size, all.size());
    int to = Math.min(from + size, all.size());
    return all.subList(from, to);
  }

  public MetadataObject object(String id, String objectId) {
    return get(id).data.objects().stream().filter(o -> o.id().equals(objectId)).findFirst().orElseThrow();
  }

  public Map<String, Object> diff(String id, String path) throws IOException {
    var delta = get(id).data.fileDeltas().get(path);
    if (delta == null) throw new IllegalArgumentException("Path not found");
    return engine.diff(delta);
  }

  public void delete(String id) throws IOException {
    MutableJob job = get(id);
    jobs.remove(id);
    if (Files.exists(job.base)) try (var walk = Files.walk(job.base)) {
      walk.sorted(Comparator.reverseOrder()).forEach(p -> {
        try { Files.deleteIfExists(p); } catch (IOException ignored) {}
      });
    }
  }

  @Scheduled(fixedDelay = 60000)
  public void cleanup() {
    Instant threshold = Instant.now().minus(props.jobTtlMinutes(), ChronoUnit.MINUTES);
    jobs.values().stream().filter(j -> j.finished != null && j.finished.isBefore(threshold)).map(j -> j.id).toList().forEach(id -> {
      try { delete(id); } catch (Exception ignored) {}
    });
  }

  private MutableJob get(String id) {
    MutableJob job = jobs.get(id);
    if (job == null) throw new IllegalArgumentException("Job not found");
    return job;
  }

  static class MutableJob {
    final String id; final Instant created = Instant.now(); final Path base;
    volatile int progress = 0; volatile String stage = "Queued"; volatile Instant finished;
    volatile JobData data;

    MutableJob(String id, Path base) {
      this.id = id; this.base = base;
      this.data = new JobData(toJob(JobStatus.QUEUED, progress, stage, null, Map.of(), Map.of(), Map.of()), List.of(), Map.of());
    }

    static MutableJob queued(String id, Path base) { return new MutableJob(id, base); }

    void update(int progress, String stage, JobStatus st, String error) {
      this.progress = progress; this.stage = stage;
      this.data = new JobData(toJob(st, progress, stage, error, data.job().leftMetaSummary(), data.job().rightMetaSummary(), data.job().diffSummary()), data.objects(), data.fileDeltas());
    }

    CompareJob toJob(JobStatus st, int prog, String stage, String error, Map<String, Long> left, Map<String, Long> right, Map<String, Long> diff) {
      return new CompareJob(id, st, created, finished, prog, stage, left, right, diff, error);
    }
  }
}
