// Константы
const CONSTANTS = {
    BED_FRAME_WIDTH_ADD: 13,
    SOFA_DEPTH_ADD: 80,
    SOFA_HEIGHT_ADD: 22
};

// ЦВЕТА И ТЕКСТУРЫ
// Замени ссылки 'https://...' на свои пути к картинкам текстур (например 'images/colors/white.jpg')
const COLORS = {
    LDSP: [
        { id: 'white', name: 'Белый', image: 'images/textures/white_ldsp.jpg.jpg' },
        { id: 'grey', name: 'Серый', image: 'images/textures/gray_ldsp.jpg' },
        { id: 'beige', name: 'Бежевый', image: 'images/textures/beige_ldsp.jpg' },
        { id: 'sonoma', name: 'Сонома', image: 'images/textures/sonoma_ldsp.jpg' },
        { id: 'wenge', name: 'Венге', image: 'images/textures/venge_ldsp.jpg' },
        { id: 'anthracite', name: 'Антрацит', image: 'images/textures/anthracit_ldsp.jpg' }
    ],
    FABRIC: [
        { id: 'grey_fabric', name: 'Велюр Серый', image: 'images/textures/gray_velour.png' },
        { id: 'dark_fabric', name: 'Велюр Темный', image: 'images/textures/dark_velour.png' },
        { id: 'blue_fabric', name: 'Велюр Синий', image: 'images/textures/blue_velour.png' },
        { id: 'brown_fabric', name: 'Велюр Коричневый', image: 'images/textures/brown_velour.png' }
    ]
};

// КАТАЛОГ
const MODULES = [
    // --- КРОВАТИ ---
    // price: цена БЕЗ дивана
    // priceWithSofa: цена ПРИ НАЛИЧИИ дивана
    {
        id: 'bed_140',
        type: 'bed',
        name: 'Кровать 140x200',
        price: 38000,
        priceWithSofa: 41000, // Пример более высокой цены
        width: 140,
        height: 220,
        depth: 44,
        weight: 180,
        category: 'ldsp',
        image: 'images/beds/bed160.png'
    },
    {
        id: 'bed_160',
        type: 'bed',
        name: 'Кровать 160x200',
        price: 38000,
        priceWithSofa: 41000,
        width: 160,
        height: 220,
        depth: 44,
        weight: 180,
        category: 'ldsp',
        image: 'images/beds/bed160.png'
    },
    {
        id: 'bed_180',
        type: 'bed',
        name: 'Кровать 180x200',
        price: 43000,
        priceWithSofa: 47000,
        width: 180,
        height: 220,
        depth: 44,
        weight: 180,
        category: 'ldsp',
        image: 'images/beds/bed160.png'
    },

    // --- ДИВАНЫ ---
    {
        id: 'sofa_std',
        type: 'sofa',
        name: 'Диван прямой',
        price: 25000,
        priceWithSofa: 25000, // Цена дивана обычно не меняется от наличия дивана :)
        width: 0, 
        height: 0,
        depth: 0, 
        weight: 60,
        category: 'fabric',
        image: 'images/sofa/sofa.png'
    },

    // --- ШКАФЫ ---
    {
        id: 'penal_1',
        type: 'storage',
        name: 'Пенал 1-ств.',
        price: 12500,
        priceWithSofa: 15500, // Если шкафы тоже дорожают из-за глубины/высоты с диваном
        width: 45,
        height: 220,
        depth: 44,
        weight: 60,
        category: 'ldsp',
        image: 'images/modules/wardrobe_1.png'
    },
    {
        id: 'wardrobe_2',
        type: 'storage',
        name: 'Шкаф 2-ств.',
        price: 19500,
        priceWithSofa: 22500,
        width: 80,
        height: 220,
        depth: 44,
        weight: 120,
        category: 'ldsp',
        image: 'images/modules/wardrobe_2.png'
    },
    {
        id: 'shelf_open',
        type: 'storage',
        name: 'Полки',
        price: 10000,
        priceWithSofa: 10000,
        width: 20,
        height: 220,
        depth: 44,
        weight: 60,
        category: 'ldsp',
        image: 'images/modules/shelves.png'
    }
];