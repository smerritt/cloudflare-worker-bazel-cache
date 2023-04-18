# cloudflare-worker-bazel-cache

Contents
========

 * [What is this?](#what)
 * [Installation](#installation)

# What is this?

This is a build cache for [Bazel](https://bazel.build/). If your team
has one of these, they can share build outputs, which means not
everyone has to rebuild everything when it changes. It runs as a
Cloudflare worker.

There are many other Bazel build caches out there, such as

 * [bazel-remote](https://github.com/buchgr/bazel-remote/)
 * [Google Cloud Storage](https://cloud.google.com/storage/docs): a bucket that auto-deletes old objects makes a decent cache
 * [BuildBuddy](https://www.buildbuddy.io/): this one also does remote building
 * ... and many more

This exists because I wanted something that's easy to set up and cheap
to run.

# Installation

There are four steps: configuring the file storage, setting up the
database, deploying the worker, and creating some auth tokens for
users.

## Step 0: Prerequisites

We'll need [wrangler](https://www.npmjs.com/package/wrangler), so
install that somewhere.

Copy `wrangler.toml-example` to `wrangler.toml`. There are four values
that will need to be replaced.

## Step 0.5: Naming

Pick a name for the worker. "bazelcache" is a good one, or perhaps
"bzc" if you like three-letter acronyms. Put that name into
`wrangler.toml` after `name =`.

## Step 1: Storage

Using the Cloudflare dashboard or the wrangler command-line tool,
create an R2 bucket. The bucket will need a name; this can be the same
as the name of the worker to keep things grouped together. Take the
name of that bucket and put it into your `wrangler.toml` in the
`[[r2_buckets]]` section.

## Step 2: Database

This worker uses a D1 database to store the times at which cached
files were last used; this lets it delete unused files so the cache's
size doesn't grow without bound.

Pick a database name (the name of the worker is a good choice, but
anything works) and create it with `wrangler d1 create <name>`. Take
the name and UUID and put them in your wrangler.toml in the
`[[d1_databases]]` section.

Next, initialize the database with `wrangler d1 execute <name>
--file=./schema.sql`.

## Step 3: Deployment

Run `npm run deploy`.

This will deploy the worker to
`https://<worker-name>.<account-name>.workers.dev/`. Take note of that
URL; users will need it later.

If you're feeling fancy, you can set up a custom domain name for the
worker, but that is outside the scope of these instructions.

<!-- TODO: make npm scripts for the above initialization stuff -->

## Step 4: Auth Tokens

Each user needs their own auth token. These tokens are stored in the
R2 bucket created at setup time.

First, for each user, pick a random value somehow. For example, to
make random values for Alice and Bob, you could run

`perl -e 'print join "", map { unpack "H*", chr(rand(256)) } 1..16' >
alice-token` and `perl -e 'print join "", map { unpack "H*",
chr(rand(256)) } 1..16' > bob-token`. That leaves the tokens on your
local filesystem.

To upload a token to R2, use wrangler: `npx wrangler r2 object put
bazelcache/tokens/alice --file alice-token` and `npx wrangler r2
object put bazelcache/tokens/bob --file bob-token`. (Replace
"bazelcache" with the name of your R2 bucket.)

Finally, tell Alice and Bob their token names ("alice" and "bob",
respectively), values (random hex, one hopes), and the location of . They will use
those values to fill in their bazelrc files.

# Usage

So you've been handed an URL, a token name, a token value, and told to
start using this new fancy cache. Good news: it's easy.

To your `~/.bazelrc`, add the following lines:

```
build --remote_cache=<REPLACE ME WITH YOUR CACHE'S URL>
build --remote_header=Bazel-Cache-Token-Id=<REPLACE ME WITH YOUR TOKEN NAME>
build --remote_header=Bazel-Cache-Token-Value=<REPLACE ME WITH YOUR TOKEN VALUE>
```

With that in place, your builds should start using the remote cache.