export type EmojiItem = { e: string; n: string; k: string };
export type EmojiGroup = { name: string; items: EmojiItem[] };

const entries = (rows: string): EmojiItem[] => rows.trim().split('\n').map((row) => {
  const [e, n, k] = row.split('|');
  return { e, n, k };
});

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: 'Smileys',
    items: entries(`
😀|Grinning face|smile happy grin
😁|Beaming face|grin smile happy
😅|Grinning face with sweat|nervous laugh relief
😂|Face with tears of joy|laugh funny happy
🤣|Rolling on the floor laughing|rofl funny laugh
🥲|Smiling face with tear|proud grateful moved
😊|Smiling face with smiling eyes|smile happy warm
😇|Smiling face with halo|angel innocent
🙃|Upside-down face|silly playful
😉|Winking face|wink playful
😌|Relieved face|calm peaceful
😍|Smiling face with heart-eyes|love crush
🥰|Smiling face with hearts|love adore
😘|Face blowing a kiss|kiss love
😛|Face with tongue|silly playful
😜|Winking face with tongue|silly joke
🤪|Zany face|wild silly crazy
🤗|Hugging face|hug thanks welcome
🤭|Face with hand over mouth|oops giggle
🤫|Shushing face|quiet secret
🤔|Thinking face|think consider hmm
🫡|Saluting face|respect yes
🤨|Face with raised eyebrow|skeptical doubt
😐|Neutral face|neutral okay
😏|Smirking face|smirk sly
😒|Unamused face|annoyed unimpressed
🙄|Face with rolling eyes|eyeroll annoyed
😬|Grimacing face|awkward nervous
🥱|Yawning face|tired sleepy
😴|Sleeping face|sleep tired
🤯|Exploding head|mind blown amazed
🥳|Partying face|celebrate party birthday
😎|Smiling face with sunglasses|cool sunny
🤓|Nerd face|smart glasses
😲|Astonished face|shocked surprised
😳|Flushed face|embarrassed surprised
🥺|Pleading face|please cute hopeful
😢|Crying face|sad tear
😭|Loudly crying face|sad sob tears
😱|Face screaming in fear|shocked scared
🥶|Cold face|freezing cold
🥵|Hot face|warm heat
🤢|Nauseated face|sick gross
😷|Face with medical mask|sick health
🤡|Clown face|funny silly
💩|Pile of poo|poop funny
👻|Ghost|spooky halloween
💀|Skull|dead danger
☠️|Skull and crossbones|danger poison
👽|Alien|space extraterrestrial
👾|Alien monster|game space
🤖|Robot|technology bot
`),
  },
  {
    name: 'Gestures',
    items: entries(`
👋|Waving hand|hello goodbye wave
✋|Raised hand|stop high five
👌|OK hand|okay good perfect
✌️|Victory hand|peace win
🤞|Crossed fingers|luck hope
🤟|Love-you gesture|love sign
🤘|Sign of the horns|horns metal music
🤙|Call me hand|phone call
👈|Backhand index pointing left|left direction
👉|Backhand index pointing right|right direction
👆|Backhand index pointing up|up direction
👇|Backhand index pointing down|down direction
☝️|Index pointing up|one direction
🫵|Index pointing at the viewer|you point
👍|Thumbs up|thumbsup yes approve like
👎|Thumbs down|thumbsdown no dislike
✊|Raised fist|power solidarity
👊|Oncoming fist|punch bump
👏|Clapping hands|clap applause bravo
🙌|Raising hands|celebrate hooray
👐|Open hands|open hug
🤲|Palms up together|please prayer
🙏|Folded hands|please thanks pray
✍️|Writing hand|write note
💅|Nail polish|style manicure
💪|Flexed biceps|strong strength muscle
🦾|Mechanical arm|robot prosthetic
🦿|Mechanical leg|robot prosthetic
🦵|Leg|body kick
🦶|Foot|body
👂|Ear|listen sound
👃|Nose|smell
`),
  },
  {
    name: 'Hearts and symbols',
    items: entries(`
💖|Sparkling heart|love shiny
💗|Growing heart|love
💓|Beating heart|love pulse
💞|Revolving hearts|love
💕|Two hearts|love
❤️|Red heart|love favorite
🩷|Pink heart|love
🧡|Orange heart|love
💛|Yellow heart|love
💚|Green heart|love
💙|Blue heart|love
🩵|Light blue heart|love
💜|Purple heart|love
🤎|Brown heart|love
🖤|Black heart|love
🩶|Grey heart|love
🤍|White heart|love
💔|Broken heart|sad love
❤️‍🔥|Heart on fire|passion love
❤️‍🩹|Mending heart|healing love
💯|Hundred points|100 score perfect
💢|Anger symbol|mad comic
💥|Collision|boom impact
💫|Dizzy|stars sparkle
💦|Sweat droplets|water effort
💨|Dashing away|fast wind
💬|Speech balloon|talk message
👀|Eyes|look watch notice
💭|Thought balloon|think idea
💤|Zzz|sleep tired
🔔|Bell|notification alert
🔕|Bell with slash|mute notifications
ℹ️|Information|info help
🆔|ID button|identity
🚫|Prohibited|no forbidden
⚠️|Warning|caution alert
⛔|No entry|stop forbidden
✅|Check mark button|check done yes
☑️|Check box with check|check complete
✔️|Check mark|correct done
❌|Cross mark|no wrong delete
❎|Cross mark button|wrong no
➕|Plus sign|add math
➖|Minus sign|subtract math
➗|Division sign|math divide
🟰|Heavy equals sign|math equal
❓|Red question mark|question help
❔|White question mark|question help
❕|White exclamation mark|alert
❗|Red exclamation mark|alert important
‼️|Double exclamation mark|alert
⁉️|Exclamation question mark|surprise
⚡|High voltage|lightning energy
🔥|Fire|hot flame great
⬆️|Up arrow|arrow up direction
➡️|Right arrow|arrow right direction
⬇️|Down arrow|arrow down direction
⬅️|Left arrow|arrow left direction
↗️|Up-right arrow|arrow direction
↘️|Down-right arrow|arrow direction
↙️|Down-left arrow|arrow direction
↖️|Up-left arrow|arrow direction
↔️|Left-right arrow|arrow direction
↕️|Up-down arrow|arrow direction
🎯|Bullseye|target goal focus
⭐|Star|favorite rating
🌟|Glowing star|bright success
✨|Sparkles|magic shine
❇️|Sparkle|shine
💠|Diamond with a dot|gem
🔱|Trident emblem|symbol
🛑|Stop sign|stop halt
🟢|Green circle|status go
🟡|Yellow circle|status waiting
🔴|Red circle|status stop
🟠|Orange circle|status
🔵|Blue circle|status
🟣|Purple circle|status
⚫|Black circle|status
⚪|White circle|status
🟤|Brown circle|status
⬛|Black large square|black
⬜|White large square|white
1️⃣|Keycap 1|number one
2️⃣|Keycap 2|number two
3️⃣|Keycap 3|number three
4️⃣|Keycap 4|number four
5️⃣|Keycap 5|number five
6️⃣|Keycap 6|number six
7️⃣|Keycap 7|number seven
8️⃣|Keycap 8|number eight
9️⃣|Keycap 9|number nine
🔟|Keycap 10|number ten
`),
  },
  {
    name: 'People and work',
    items: entries(`
🧑‍💻|Technologist|person computer code developer
👩‍💻|Woman technologist|person computer code developer
👨‍💻|Man technologist|person computer code developer
🧑‍🏫|Teacher|person school teach
🧑‍🔬|Scientist|person research lab
🧑‍🚀|Astronaut|person space explore
🧑‍⚕️|Health worker|person doctor medicine
🧑‍🔧|Mechanic|person repair tools
🧑‍💼|Office worker|person business work
🧑‍🎨|Artist|person creative art
🧑‍🍳|Cook|person chef food
🧑‍⚖️|Judge|person law court
🧑‍🌾|Farmer|person garden plants
🧑‍🚒|Firefighter|person fire rescue
🧑‍✈️|Pilot|person travel plane
🧑‍🎓|Student|person graduate school
🧑‍🏭|Factory worker|person industry work
🧑‍🦽|Person in manual wheelchair|person access
🧑‍🦯|Person with white cane|person access
🧑‍🦼|Person in motorized wheelchair|person access
🧘|Person in lotus position|person meditate calm
👥|Busts in silhouette|people team group
🗣️|Speaking head|talk communicate
🫂|People hugging|support care
`),
  },
  {
    name: 'Objects',
    items: entries(`
💡|Light bulb|idea bright think
🔦|Flashlight|light
🕯️|Candle|light
💻|Laptop|computer work
🖥️|Desktop computer|computer work
🖨️|Printer|computer print
⌨️|Keyboard|computer typing
🖱️|Computer mouse|computer click
📱|Mobile phone|phone device
🔋|Battery|power charge
🪫|Low battery|power empty
🔌|Electric plug|power cable
💰|Money bag|money cash
💳|Credit card|payment money
💶|Euro banknote|money cash
🛠️|Hammer and wrench|tools repair build
🔨|Hammer|tools build
🪛|Screwdriver|tools repair
🔩|Nut and bolt|tools repair
⚙️|Gear|settings tools
⌛|Hourglass done|time sand timer
⏳|Hourglass not done|time wait sand
🧰|Toolbox|tools repair
🪚|Carpentry saw|tools wood
🔧|Wrench|tools repair settings
🔒|Locked|lock security
🔓|Unlocked|lock open security
🔏|Locked with pen|lock security
🔐|Locked with key|lock security
🔑|Key|lock security access
🔍|Magnifying glass tilted left|search find inspect
🔎|Magnifying glass tilted right|search find inspect
🦠|Microbe|bug virus
🧪|Test tube|science lab experiment
🎒|Backpack|bag school travel
📚|Books|read library study
📖|Open book|read study
📝|Memo|note write
✏️|Pencil|write edit
🖊️|Pen|write
📌|Pushpin|pin save
📍|Round pushpin|location map
📎|Paperclip|attach
🖇️|Linked paperclips|attach
📏|Straight ruler|measure
📐|Triangular ruler|measure design
✂️|Scissors|cut
🗂️|Card index dividers|files organize
📋|Clipboard|copy list
📂|Open file folder|folder files
📁|File folder|folder files
🗄️|File cabinet|files organize
🗑️|Wastebasket|delete trash
📰|Newspaper|news
📓|Notebook|notes write
📒|Ledger|notes finance
📕|Closed book|read book
📗|Green book|read book
📘|Blue book|read book
📙|Orange book|read book
📄|Page facing up|document file
📑|Bookmark tabs|document mark
🗒️|Spiral notepad|notes memo
📆|Tear-off calendar|calendar date
📅|Calendar|calendar date schedule
🗓️|Spiral calendar|calendar date schedule
🧾|Receipt|invoice payment
📈|Chart increasing|chart growth data
📉|Chart decreasing|chart decline data
📊|Bar chart|chart data graph
📇|Card index|contacts file
📦|Package|box deliver
🚀|Rocket|space launch travel
🎁|Wrapped gift|gift present
🎉|Party popper|celebrate tada
🎊|Confetti ball|celebrate party
🎈|Balloon|party celebrate
🏆|Trophy|award win
🥇|First place medal|gold win
🥈|Second place medal|silver win
🥉|Third place medal|bronze win
🏅|Sports medal|award win
`),
  },
  {
    name: 'Nature and food',
    items: entries(`
🌱|Seedling|plant grow nature
🌿|Herb|plant leaf nature
🍀|Four leaf clover|luck plant
🌳|Deciduous tree|tree nature
🌴|Palm tree|tree tropical
🌵|Cactus|plant desert
🌷|Tulip|flower plant
🌹|Rose|flower plant
🌻|Sunflower|flower plant
🌸|Cherry blossom|flower plant
🍁|Maple leaf|leaf autumn
🍂|Fallen leaf|autumn fall
🍃|Leaf fluttering in wind|leaf nature
🍄|Mushroom|fungus nature
🐛|Bug|insect code error
🌍|Globe showing Europe and Africa|earth world
🌎|Globe showing Americas|earth world
🌞|Sun with face|sun bright
🌕|Full moon|moon night
🌙|Crescent moon|moon night
☀️|Sun|sunny weather
⛅|Sun behind cloud|weather partly cloudy
🌧️|Cloud with rain|weather rain
⛈️|Cloud with lightning and rain|weather storm
❄️|Snowflake|cold snow winter
🌈|Rainbow|weather color
☂️|Umbrella|rain weather
🌊|Water wave|sea ocean
🌋|Volcano|mountain lava
🍎|Red apple|fruit food
🍊|Mandarin|orange fruit food
🍋|Lemon|fruit food
🍌|Banana|fruit food
🍉|Watermelon|fruit food
🍇|Grapes|fruit food
🍓|Strawberry|fruit food
🫐|Blueberries|fruit food
🍑|Peach|fruit food
🥭|Mango|fruit food
🍍|Pineapple|fruit food
🥑|Avocado|vegetable food
🥕|Carrot|vegetable food
🌽|Ear of corn|vegetable food
🌶️|Hot pepper|spicy food
🍞|Bread|food bakery
🧀|Cheese wedge|food dairy
🥚|Egg|food breakfast
🍳|Cooking|food breakfast
🍔|Hamburger|food burger
🍟|French fries|food
🍕|Pizza|food
🥪|Sandwich|food lunch
🌮|Taco|food
🥗|Green salad|food healthy
🍜|Steaming bowl|food noodles
🍣|Sushi|food japanese
🍙|Rice ball|food japanese
🥟|Dumpling|food
🍦|Soft ice cream|food dessert
🍩|Doughnut|food dessert
🍪|Cookie|food dessert
🎂|Birthday cake|food birthday
☕|Hot beverage|coffee tea
🧋|Bubble tea|tea drink
`),
  },
  {
    name: 'Flags',
    items: entries(`
🇸🇪|Sweden|flag country swedish
🇪🇺|European Union|flag europe eu
🇬🇧|United Kingdom|flag britain uk
🇺🇸|United States|flag america usa us
🏳️‍🌈|Rainbow flag|flag pride lgbtq
🏴‍☠️|Pirate flag|flag pirate
`),
  },
];
