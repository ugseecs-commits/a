#!/bin/bash
echo "===================================================="
echo " Starting local web server for Mantiq..."
echo " Open http://localhost:8000 in your browser."
echo " Press Ctrl+C to stop the server."
echo "===================================================="
echo

python3 -m http.server 8000 || python -m http.server 8000
