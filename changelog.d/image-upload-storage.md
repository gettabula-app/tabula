section: Fixed
audience: user

- Adding an image now works in browsers that refuse to store images (Safari in a private window, for one): the image is kept in memory until it uploads, and stored as plain bytes where the browser allows. It tells you when your browser will not keep a copy to upload, and two tabs of the same board no longer report an image as lost when the other tab has just uploaded it.
- Icons with rounded corners no longer log an error in Safari.
