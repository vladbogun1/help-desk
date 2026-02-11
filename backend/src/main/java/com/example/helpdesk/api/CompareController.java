package com.example.helpdesk.api;

import com.example.helpdesk.service.CompareJobService;
import jakarta.validation.constraints.Min;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api")
@Validated
public class CompareController {
  private final CompareJobService service;

  public CompareController(CompareJobService service) { this.service = service; }

  @PostMapping(value = "/compare", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public Map<String, String> create(@RequestParam MultipartFile leftFile, @RequestParam MultipartFile rightFile) throws IOException {
    validateExt(leftFile); validateExt(rightFile);
    return Map.of("jobId", service.create(leftFile, rightFile));
  }

  @GetMapping("/compare/{jobId}")
  public Object status(@PathVariable String jobId) { return service.job(jobId); }

  @GetMapping("/compare/{jobId}/objects")
  public Object objects(@PathVariable String jobId,
                        @RequestParam(required = false) String q,
                        @RequestParam(required = false) String type,
                        @RequestParam(required = false) String status,
                        @RequestParam(defaultValue = "0") @Min(0) int page,
                        @RequestParam(defaultValue = "200") @Min(1) int size) {
    var content = service.objects(jobId, q, type, status, page, size);
    return Map.of("content", content, "page", page, "size", size, "count", content.size());
  }

  @GetMapping("/compare/{jobId}/object/{objectId}")
  public Object object(@PathVariable String jobId, @PathVariable String objectId) { return service.object(jobId, objectId); }

  @GetMapping("/compare/{jobId}/diff")
  public Object diff(@PathVariable String jobId, @RequestParam String path) throws IOException { return service.diff(jobId, path); }

  @DeleteMapping("/compare/{jobId}")
  public void delete(@PathVariable String jobId) throws IOException { service.delete(jobId); }

  @GetMapping("/health")
  public Map<String, String> health() { return Map.of("status", "UP"); }

  @GetMapping("/version")
  public Map<String, String> version() { return Map.of("version", "0.0.1"); }

  private void validateExt(MultipartFile f) {
    String n = f.getOriginalFilename() == null ? "" : f.getOriginalFilename().toLowerCase();
    if (!(n.endsWith(".cf") || n.endsWith(".cfe") || n.endsWith(".epf"))) {
      throw new IllegalArgumentException("Only .cf/.cfe/.epf files are allowed");
    }
  }
}
