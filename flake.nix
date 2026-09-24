# SPDX-FileCopyrightText: 2026 The Pion community <https://pion.ly>
# SPDX-License-Identifier: MIT
{
  description = "Pion browser tests development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
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
              pkgs.go
              pkgs.nodejs_24
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
              pkgs.chromium
              pkgs.chromedriver
              pkgs.firefox
              pkgs.geckodriver
            ];

            shellHook = ''
              echo "Pion browser tests dev shell"
              echo "- node:         $(node --version)"
              echo "- go:           $(go version)"
            '' + pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export CHROME_BIN=${pkgs.chromium}/bin/chromium
              export CHROMEDRIVER_PATH=${pkgs.chromedriver}/bin/chromedriver
              export FIREFOX_BIN=${pkgs.firefox}/bin/firefox
              export GECKODRIVER_PATH=${pkgs.geckodriver}/bin/geckodriver
              echo "- chromium:     $(chromium --version 2>/dev/null)"
              echo "- firefox:      $(firefox --version 2>/dev/null)"
              echo "- chromedriver: $(chromedriver --version 2>/dev/null | head -1)"
              echo "- geckodriver:  $(geckodriver --version 2>/dev/null | head -1)"
              echo ""
              echo "Run tests:"
              echo "- npm run test:chrome"
              echo "- npm run test:firefox"
            '' + pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
              echo "Use installed macOS browsers; Safari requires Remote Automation."
              echo "Run tests: npm run test:safari"
            '';
          };
        });
    };
}
