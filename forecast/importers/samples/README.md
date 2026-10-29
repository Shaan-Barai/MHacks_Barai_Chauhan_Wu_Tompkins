# SIMULATED sample files

Everything here is **synthetic**, made up for the importer tests. None of it is M-Dining data.

- `sample_SIMULATED_swipes.csv`: pre-counted 15-minute swipes. It contains deliberate problems (a duplicate row, a negative count, an impossible count, a fractional count, a row outside meal hours, an unknown location) so the validation report has something to show.
- `sample_SIMULATED_fss.csv`: an FSS-style forecast export with lb/oz/kg/portion units, one alias match, one unmatched dish (goes to review) and one bad date.
- `sample_SIMULATED_sheets/`: three 8×8 grey PNGs standing in for sheet photos (tests mock the sheet reader; nothing is sent to Gemini).

Mapping examples: `../mappings/*.example.toml`.
