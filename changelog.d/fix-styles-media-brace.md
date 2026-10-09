section: Fixed

- A missing closing brace in the stylesheet (since the steps list change for phones, TAB-242) made every rule after it apply only on a narrow screen. The brace is back, and a test now checks that every stylesheet has balanced braces.
