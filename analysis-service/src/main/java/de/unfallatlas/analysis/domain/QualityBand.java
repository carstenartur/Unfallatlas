package de.unfallatlas.analysis.domain;

/**
 * Drei-stufige Qualitätsbänder, wie sie im Brief und im politischen
 * Kontext aus PR #199 verwendet werden.
 */
public enum QualityBand {
    LOW,
    MEDIUM,
    HIGH;

    public static QualityBand fromIgnoreCase(String s) {
        if (s == null) return null;
        return switch (s.trim().toLowerCase()) {
            case "low"    -> LOW;
            case "medium" -> MEDIUM;
            case "high"   -> HIGH;
            default       -> null;
        };
    }

    public String toLower() { return name().toLowerCase(); }
}
