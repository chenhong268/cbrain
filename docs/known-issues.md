# Known Issues

## v0.3.0

### SKILL.md modifications not taking effect

- **Symptom**: After modifying the skill file and restarting the agent, the agent does not follow the new rules.
- **Impact**: Protocol updates need to be written to the agent's primary memory file to take effect.
- **Workaround**: Write key rules to the agent's memory file; keep SKILL.md as reference documentation.
