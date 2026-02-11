FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q -DskipTests dependency:go-offline
COPY src src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Optional v8unpack: if unavailable at runtime, backend uses raw fallback
RUN curl -fsSL https://raw.githubusercontent.com/e8tools/v8unpack/master/v8unpack -o /usr/local/bin/v8unpack || true \
 && chmod +x /usr/local/bin/v8unpack || true
COPY --from=build /app/target/*.jar app.jar
VOLUME ["/work"]
EXPOSE 8080
ENTRYPOINT ["java","-jar","/app/app.jar"]
