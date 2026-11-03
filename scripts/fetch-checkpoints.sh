#!/usr/bin/env bash
# Downloads what the three compilers read into $1/<model>, each file pinned by revision and checked
# by sha256 (files already present are only checked), as the models' own product repositories pin
# them: moondream/parakeet-redux (parakeet-redux-wasm), gradium/phonon-31m-en with the catalog
# voices of gradium/phonon-voices (phonon-wasm), and LiquidAI/LFM3-1.7B (liquidai-lmf3-wasm).
set -euo pipefail
DIR="$1"
PARAKEET="https://huggingface.co/moondream/parakeet-redux/resolve/2bf128600aac4b16946f7ed8372e56117fe5e23b"
PHONON="https://huggingface.co/gradium/phonon-31m-en/resolve/52433c46975bfa13144c56204c9f4ee1c5b148aa"
VOICES="https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7"
LFM3="https://huggingface.co/LiquidAI/LFM3-1.7B/resolve/40ebe0aa6662c9d40389c2f5d565b6a2c6aebacd"
FILES="
503c653b2e3bb788adbcb04f5abdee532d958686564081baeed133ff10143f6e  parakeet-redux  config.json  $PARAKEET
1221c6d3ce901ffe09c089da758a8db8b76189f80cff41c5afc244fc61e2051d  parakeet-redux  ternary.json  $PARAKEET
bd321b096832a3f270bd3b2a88823957920f1a5c5ada71114a26ea729d0cbe91  parakeet-redux  tokenizer.json  $PARAKEET
78ec25733ee0d0c1586d1346fc86db9d0c2e436e3a8ab1d32a82d1bb8f848d21  parakeet-redux  model.safetensors  $PARAKEET
7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06  phonon-31m-en  config.json  $PHONON
691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936  phonon-31m-en  tokenizer.json  $PHONON
8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607  phonon-31m-en  model.safetensors  $PHONON
f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18  phonon-31m-en  default-voice.safetensors  $PHONON
6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123  phonon-31m-en  voices/4SZHfMpw-p46Ywgs.safetensors  $VOICES
eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8  phonon-31m-en  voices/d9XCyhjo4JhkHF1d.safetensors  $VOICES
a0c3dcb91b2247eca56536be9ae8e8becc1c807b1136c5fe101552d6a155b24a  phonon-31m-en  voices/nGzMHMPAWGaJFHOo.safetensors  $VOICES
6e04b84d3ae8751b22bca0a4f63936f9cb648f4f2182b2d0788071ea1c0b68a1  phonon-31m-en  voices/qIxlZ7Ei8KvWlyQH.safetensors  $VOICES
56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844  phonon-31m-en  voices/6PWnV0Nq4wu7RVBT.safetensors  $VOICES
ff1d0735b8b45710462b1d1f846da040f970c6eb62c7c2f36dbfb8e5bde74f1e  phonon-31m-en  voices/zUCxzrOrugTSis03.safetensors  $VOICES
4d28ca14dedc0b3d0fcc2b3339f0e79931faa33874f3d24f522183a8fc70068c  lfm3-1.7b  LICENSE  $LFM3
f45005c50cd2a97329722bf3a2dee9f16c04cdf825a589b280fb7e99e6827818  lfm3-1.7b  chat_template.jinja  $LFM3
8c6ae8b8f6d88c87cfb98cf4b5e34e943d0ee07e24215c4121b3159a46e1399d  lfm3-1.7b  config.json  $LFM3
0095ba7158e938b1e2d3082d412f00d8be85e42cbbd7608b63866f7a081cf270  lfm3-1.7b  generation_config.json  $LFM3
7946f864cbfb62a1b041bda937244210a1a87f4a6cab3a48b791131b2cd57f88  lfm3-1.7b  special_tokens_map.json  $LFM3
7e226e34bface23ccf6e495d157bf77186c1c30a7659880e1a8994db528c3701  lfm3-1.7b  tokenizer.json  $LFM3
bf028f813efc6137bc07ed045cafe71820df9a5e26a38e39954706ed1e30a457  lfm3-1.7b  tokenizer_config.json  $LFM3
135922caef64e81e52af88ede8b7c3ddaa9d6da220a9737fb3065275dbfb4330  lfm3-1.7b  model.safetensors  $LFM3
"
while read -r _ model file base; do
  if [ -z "$file" ] || [ -s "$DIR/$model/$file" ]; then continue; fi
  echo "downloading $model/$file"
  mkdir -p "$(dirname "$DIR/$model/$file")"
  curl -fsSL --retry 3 -o "$DIR/$model/$file.part" "$base/$file"
  mv "$DIR/$model/$file.part" "$DIR/$model/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { print $1 "  " $2 "/" $3 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
