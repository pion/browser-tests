# SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
# SPDX-License-Identifier: MIT
{
  description = "Pion browser tests development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = [
              pkgs.chromium
              pkgs.chromedriver
              pkgs.firefox
              pkgs.geckodriver
              pkgs.nodejs_23
            ];

            shellHook = ''
              export CHROME_BIN=$(which chromium)
              echo "Pion browser tests dev shell"
              echo "- node:         $(node --version)"
              echo "- chromium:     $(chromium --version 2>/dev/null)"
              echo "- firefox:      $(firefox --version 2>/dev/null)"
              echo "- chromedriver: $(chromedriver --version 2>/dev/null | head -1)"
              echo "- geckodriver:  $(geckodriver --version 2>/dev/null | head -1)"
              echo ""
              echo "Run tests:"
              echo "- npm run test:chrome"
              echo "- npm run test:firefox"
            '';
          };
        });
    };
}

