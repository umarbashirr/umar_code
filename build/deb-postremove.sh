#!/bin/bash
if [ "$1" = "purge" ] || [ "$1" = "remove" ]; then
  rm -f /usr/bin/tandem
fi
