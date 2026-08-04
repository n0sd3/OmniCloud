# MegaBasterd headless overlay

This directory builds an overlay for [tonikelope/megabasterd](https://github.com/tonikelope/megabasterd) at commit `3b204d226515a6f4ecb6630371e19722077b03fc`.

Overlaid files:

- `src/com/tonikelope/megabasterd/HeadlessTransfer.java`
- `src/com/tonikelope/megabasterd/HeadlessTransferException.java`
- `src/com/tonikelope/megabasterd/HeadlessServer.java`
- `src/com/tonikelope/megabasterd/HeadlessHealthcheck.java`
- `test/com/tonikelope/megabasterd/HeadlessTransferTest.java`
- `test/com/tonikelope/megabasterd/HeadlessServerTest.java`

Build command:

```sh
docker build -t omnicloud-megabasterd:test megabasterd-headless
```

The full corresponding source is the pinned upstream source plus this directory.
