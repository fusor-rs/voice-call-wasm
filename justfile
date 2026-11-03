# A voice call in the browser: Parakeet Redux hears you, LFM3-1.7B answers, Phonon speaks the
# answer. `just ui` builds everything, the models included, and serves the page; `just build` then
# `just serve` do the same in two steps.

# `native` and `runtimes` below are product.just's for all three of the page's fusor-ai models.
set allow-duplicate-recipes

import 'vendor/fusor-ai/just/product.just'

# product.just's model, whose CLI's version (every fusor-ai crate's) the recipes read.
name := "lfm3"
# Each model's runtime crate; its runtimes go to app/engine/dist/<crate>.
runtimes := "parakeet phonon lfm3"
checkpoints := env_var_or_default("CHECKPOINTS", ".cache")
# LFM3's bundle and its conversation outgrow build-runtime.sh's 2 GB of shared memory.
export MAX_MEMORY := "4294967296"
# The caller's lines the checks speak into the page, one per turn, and the voice that speaks them.
caller := "fixtures/caller.txt"
calls := "fixtures/calls"
caller_voice := "miles"

host:
    bash -n scripts/fetch-checkpoints.sh
    for file in app/web/*.js app/engine/*.js scripts/*.mjs e2e/run.mjs; do node --check "$file" || exit 1; done

# Downloads the three pinned checkpoints (180 MB, 100 MB and 3.5 GB, sha256-checked) unless they
# are already there, then compiles their bundles into dist/model, LFM3's license beside its own.
model: native
    scripts/fetch-checkpoints.sh {{checkpoints}}
    rm -rf {{model}}
    target/release/parakeet compile {{checkpoints}}/parakeet-redux {{model}}/parakeet --profile ternary
    target/release/phonon compile {{checkpoints}}/phonon-31m-en {{model}}/phonon --profile q7
    target/release/lfm3 compile {{checkpoints}}/lfm3-1.7b {{model}}/lfm3-1.7b
    cp {{checkpoints}}/lfm3-1.7b/LICENSE {{model}}/lfm3-1.7b/

# Try it on localhost. The bundles and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

native:
    cd {{fusor_ai}} && {{nice}} cargo build --release -p parakeet-cli -p phonon-cli -p lfm3-cli --target-dir {{justfile_directory()}}/target

# Each model's four browser runtimes, fusor-ai's loader and worker kit next to them, and the
# sealed-runtime check.
runtimes: tools
    for crate in {{runtimes}}; do \
      for variant in {{variants}}; do \
        {{nice}} {{fusor_ai}}/scripts/build-runtime.sh $crate-runtime $variant {{engine}}/$crate || exit 1; \
        flags=""; case $variant in *threaded*) flags="--threaded";; esac; case $variant in *relaxed*) ;; *) flags="$flags --no-relaxed";; esac; \
        node {{fusor_ai}}/scripts/check-wasm-imports.mjs {{engine}}/$crate/$variant/${crate}_runtime_bg.wasm --glue {{engine}}/$crate/$variant/${crate}_runtime.js $flags || exit 1; \
      done; \
    done
    mkdir -p {{engine}}/host
    cp {{fusor_ai}}/packages/host/loader.js {{fusor_ai}}/packages/host/worker.js {{engine}}/host/

# The caller's lines spoken by Phonon's native CLI, one WAV each in fixtures/calls, from a fixed
# seed: the microphone of `just e2e`.
fixtures: model
    mkdir -p {{calls}}
    i=0; while IFS= read -r line; do \
      i=$((i + 1)); \
      target/release/phonon synth {{model}}/phonon "$line" --voice {{caller_voice}} --seed 1 -o {{calls}}/$(printf %02d $i).wav > /dev/null || exit 1; \
    done < {{caller}}

# The README's banner and flow diagram, light and dark.
images:
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node scripts/render-images.mjs

# The page and the bundles beside it, as one static site in target/site, each bundle's tensor parts
# named by their BLAKE3.
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    for bundle in parakeet phonon lfm3-1.7b; do node scripts/site-bundle.mjs {{model}}/$bundle target/site/model/$bundle || exit 1; done
    cp {{model}}/lfm3-1.7b/LICENSE target/site/model/lfm3-1.7b/

# The Space holds at most 1 GB, so it gets the page, the runtimes and LFM3's license, and the page
# loads the bundles from the model repo fusorlabs/voice-call-wasm-web (`just deploy-model`). The
# Space is created as a static Space first: creating it with the upload makes a Gradio Space,
# which Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/voice-call-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/voice-call-wasm", repo_type="space", space_sdk="static", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/voice-call-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy voice-call-wasm {{version}}",
    )
    PY

# Deploy them before the Space whenever a bundle changes: a runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's three bundles, with space/MODEL.md as their card, to the model repo
# fusorlabs/voice-call-wasm-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/voice-call-wasm-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/voice-call-wasm-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the voice-call-wasm {{version}} bundles",
    )
    PY
