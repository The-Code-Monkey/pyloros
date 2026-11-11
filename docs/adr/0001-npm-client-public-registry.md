# Use the public npm registry as the only package source

Pyloros talks the npm registry protocol directly to `registry.npmjs.org` and accepts only registry tarballs; git, URL, file, and private registry sources are rejected. A private mirror or curated proxy would move enforcement server-side and add a second trust surface, and an own registry would abandon the ecosystem Pyloros exists to secure. The consequence is that all enforcement is client-side and private packages are out of scope for v1.
