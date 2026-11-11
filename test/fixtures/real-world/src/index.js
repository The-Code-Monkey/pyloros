import { Command } from "commander";
import kleur from "kleur";
import semver from "semver";

const program = new Command();

program
  .name("fixture-app")
  .description("Pyloros real-world fixture")
  .argument("<version>", "semver version to validate")
  .action((version) => {
    const parsed = semver.valid(version);

    if (parsed === null) {
      console.error(kleur.red(`invalid version: ${version}`));
      process.exitCode = 1;
      return;
    }

    console.log(kleur.green(parsed));
  });

program.parse();
