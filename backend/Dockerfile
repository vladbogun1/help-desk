FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
COPY src src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY scripts/install-v8unpack.sh /tmp/install-v8unpack.sh
RUN sed -i 's/\r$//' /tmp/install-v8unpack.sh \
    && chmod +x /tmp/install-v8unpack.sh \
    && ( /tmp/install-v8unpack.sh || true ) \
    && rm -f /tmp/install-v8unpack.sh
COPY --from=build /app/target/*.jar app.jar
VOLUME ["/work"]
EXPOSE 8080
ENTRYPOINT ["java","-jar","/app/app.jar"]
