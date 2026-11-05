import java.nio.file.Path;
import org.mobilitydata.gtfsvalidator.input.CountryCode;
import org.mobilitydata.gtfsvalidator.runner.ApplicationType;
import org.mobilitydata.gtfsvalidator.runner.ValidationRunner;
import org.mobilitydata.gtfsvalidator.runner.ValidationRunnerConfig;
import org.mobilitydata.gtfsvalidator.util.VersionResolver;

/** Runs the MobilityData GTFS validator: java Validate <feed.zip> <report folder> */
public class Validate {
  public static void main(String[] args) throws Exception {
    ValidationRunnerConfig config = ValidationRunnerConfig.builder()
        .setGtfsSource(Path.of(args[0]).toAbsolutePath().toUri())
        .setOutputDirectory(Path.of(args[1]))
        .setCountryCode(CountryCode.forStringOrUnknown("MA"))
        .setSkipValidatorUpdate(true)
        .setPrettyJson(true)
        .build();
    ValidationRunner.Status status = new ValidationRunner(new VersionResolver(ApplicationType.CLI)).run(config);
    System.exit(status == ValidationRunner.Status.SUCCESS ? 0 : 2);
  }
}
