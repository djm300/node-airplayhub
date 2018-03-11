#!/bin/bash
service dbus start
service avahi-daemon start

nodejs /airplayhub/index.js
