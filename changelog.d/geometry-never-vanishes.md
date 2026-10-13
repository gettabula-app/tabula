section: Fixed

- An object whose position was lost (so that after a reload it sat at the board's origin, on top of other objects) is put back where it was. The app now writes back an object's position if it ever disappears, instead of showing the object at the origin.
