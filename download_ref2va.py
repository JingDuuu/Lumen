"""Compatibility entry point for the explicit, verified Ref2VA installer."""
import sys
from model_manager import main

if __name__ == "__main__":
    sys.argv[1:1] = ["install", "ref2va"]
    main()
