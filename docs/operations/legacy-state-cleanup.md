# Legacy state cleanup

shuv2code starts fresh in `.shuv2code`. It never reads, migrates, warns about,
or deletes the legacy `.t3` directory.

If you no longer use software that owns the legacy directory, inspect and back
it up before removing it manually. The exact location depends on how that
software was launched; do not assume every `.t3` directory belongs to the same
installation. Removing legacy state is never required to run shuv2code.
