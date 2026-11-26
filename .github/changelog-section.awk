# Prints the body of one version's section of CHANGELOG.md, without its heading:
#   awk -v v=0.9.0 -f .github/changelog-section.awk CHANGELOG.md
# A section starts at a line "## [<version>]" (anything may follow) and ends at the next "## ".
/^## / {
    if (inside) exit
    if (index($0, "## [" v "]") == 1) { inside = 1; next }
}
inside { print }
