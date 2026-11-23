# `contrib/fleet` — audit many targets at once

`spiderlint_fleet.py` runs one `spiderlint audit --format json` child per target under a
bounded worker pool and prints one aggregate json document. Standard library only,
no build step, no new dependency on the project.

```bash
python3 contrib/fleet/spiderlint_fleet.py https://a.example https://b.example
python3 contrib/fleet/spiderlint_fleet.py --jobs 4 --rules recommended $(cat targets.txt)
```

Exit status is `0` when every target produced a report and `1` when any child
failed, with the failures named on stderr, so it works as a CI step as it stands.

`--jobs` defaults to `min(4, cpu_count)` rather than the number of targets,
because each child is a browser.

## Why a file rather than a pipe

Each child writes to a temporary file instead of a pipe. A json report for a large
crawl is routinely tens of megabytes, and a pipe needs draining on the parent side
while the child blocks on a full buffer — easy to get subtly wrong when several
children are in flight. A temporary file sidesteps the interleaving entirely and
the kernel keeps it in page cache for the lifetime it is used.

## On the zero-copy variant, and what the measurement does and does not show

We also maintain a native variant outside this repository that binds each child's
stdout directly to an anonymous `memfd`, seals it immutable with `F_SEAL_WRITE`,
and parses it from a read-only `mmap`, so the report is never copied between the
child and the consumer:

- <https://github.com/cerebral-work/rust-shed> — the shared Rust crate set
- the accelerator itself is `spiderlint-estate-accel`, MIT, available on request

**It is deliberately not proposed for this repository.** It is Linux-only
(`memfd_create` and file seals), it needs a Rust toolchain and a PyO3 build step,
and the throughput cap in our copy is tuned to one shared host. None of that
belongs in a cross-platform CLI's own tree.

What is worth recording is the honest split in the measurement. On a four-target
fleet we measured `10,444 ms` before and `5,128 ms` after, a `2.04×` improvement.
**Most of that is concurrency, which the plain-Python runner in this directory also
gets.** The zero-copy capture accounts for the remainder, and we have not isolated
it cleanly enough to quote a figure for it alone. Treating the whole `2.04×` as a
zero-copy win would be wrong, so we are not claiming it.

The part that may interest you independently of any of this: at report sizes in
the tens of megabytes, the cost of moving `--format json` output through a pipe
and into a string is measurable rather than theoretical. If spiderlint ever grows
a `--out <path>` that writes the report directly, a fleet driver would not need
either workaround.
