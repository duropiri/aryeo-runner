#!/bin/bash
set -e

# =============================================================================
# Aryeo Delivery Runner - Docker Entrypoint
# =============================================================================
# Ensures data directories exist before starting the application.
# This handles the case where a host volume is mounted that may not have
# the required subdirectory structure.

DATA_DIR="${DATA_DIR:-/app/data}"

# Create required directories if they don't exist
# These may not exist if a fresh host volume is mounted
mkdir -p "${DATA_DIR}/auth" "${DATA_DIR}/evidence" "${DATA_DIR}/temp"

# Execute the main command
exec "$@"
