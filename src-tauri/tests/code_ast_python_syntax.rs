use std::path::Path;

use tauri_app_lib::code_ast::check_source_syntax;

const VALID_SNAKE_PYTHON: &str = concat!(
    "\"\"\"Snake game implementation target for the MAIN runtime validation.\"\"\"\n",
    "\n",
    "class Snake:\n",
    "    def get_head(self):\n",
    "        \"\"\"Return the current head position.\"\"\"\n",
    "        return self.body[-1]\n",
);

// Minimal byte-equivalent form of the real OMLX incident: four double quotes
// open line 1 and one surplus double quote closes the final return statement.
const QUOTE_CORRUPTED_SNAKE_PYTHON: &str = concat!(
    "\"\"\"\"Snake game implementation target for the MAIN runtime validation.\"\"\"\n",
    "\n",
    "class Snake:\n",
    "    def get_head(self):\n",
    "        \"\"\"Return the current head position.\"\"\"\n",
    "        return self.body[-1]\"\n",
);

#[test]
fn python_syntax_check_rejects_the_quote_corrupted_snake_post_image() {
    let malformed = check_source_syntax(
        Path::new("snake.py"),
        QUOTE_CORRUPTED_SNAKE_PYTHON.as_bytes(),
    )
    .unwrap();

    assert!(malformed.applicable);
    assert_eq!(malformed.language.as_deref(), Some("python"));
    assert!(malformed.has_errors);
    assert!(malformed.error_count > 0);
    assert_eq!(malformed.first_error_line, Some(6));
    assert!(malformed.errors.iter().any(|error| {
        error.line == 6 && error.kind == "parse_error"
    }));

    let valid = check_source_syntax(
        Path::new("snake.py"),
        VALID_SNAKE_PYTHON.as_bytes(),
    )
    .unwrap();
    assert!(valid.applicable);
    assert_eq!(valid.language.as_deref(), Some("python"));
    assert!(!valid.has_errors);
    assert_eq!(valid.error_count, 0);
}
