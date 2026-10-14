section: Fixed
audience: dev

- Signed-in users now stamp objects, votes and poll answers with their account id instead of the browser's device id, so the relay's author check passes. Notes made earlier under the device id still count as yours.
- Votes and poll answers given before the change under the device id still count as yours: dots count against your limit and can be removed, and answering a poll again moves your answer to your account id. Your name and colour are saved on the device without the account id. One-time reset on each device: the list of people you muted, the hidden idle-board hint and the reopened poll results start empty.
