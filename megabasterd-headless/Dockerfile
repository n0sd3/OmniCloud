FROM maven:3.9-eclipse-temurin-17 AS build
ARG MEGABASTERD_COMMIT=3b204d226515a6f4ecb6630371e19722077b03fc
RUN git clone https://github.com/tonikelope/megabasterd.git /src \
 && cd /src && git checkout "$MEGABASTERD_COMMIT"
COPY src/ /src/src/main/java/
COPY test/ /src/headless-test/
RUN cd /src && mvn -q -DskipTests package \
 && javac -cp target/MegaBasterd-8.57-jar-with-dependencies.jar -d target/test-classes $(find headless-test -name '*.java') \
 && java -ea -cp target/test-classes:target/MegaBasterd-8.57-jar-with-dependencies.jar com.tonikelope.megabasterd.HeadlessTransferTest \
 && java -ea -cp target/test-classes:target/MegaBasterd-8.57-jar-with-dependencies.jar com.tonikelope.megabasterd.HeadlessServerTest

FROM eclipse-temurin:17-jre
RUN useradd --system --uid 10001 megabasterd
COPY --from=build /src/target/MegaBasterd-8.57-jar-with-dependencies.jar /app/megabasterd.jar
USER 10001
EXPOSE 8788
ENTRYPOINT ["java", "-Djava.awt.headless=true", "-cp", "/app/megabasterd.jar", "com.tonikelope.megabasterd.HeadlessServer"]
