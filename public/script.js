const tg = window.Telegram.WebApp;
tg.expand();
tg.enableClosingConfirmation(); 

// if (tg.colorScheme === 'dark') document.body.classList.add('dark-mode');

const state = {
    selectedBed: null,
    cart: []
};

const els = {
    step2: document.getElementById('step-2'),
    step3: document.getElementById('step-3'),
    bottomBar: document.getElementById('bottom-bar'),
    bedsContainer: document.getElementById('beds-container'),
    sofasContainer: document.getElementById('sofas-container'),
    storageContainer: document.getElementById('storage-container'),
    cartList: document.getElementById('cart-list'),
    totalPrice: document.getElementById('total-price'),
    totalDims: document.getElementById('total-dims'),
    totalWeight: document.getElementById('total-weight'),
    btnSubmit: document.getElementById('btn-submit')
};

function init() {
    renderBeds();
    renderModulesList();
}

// Вспомогательная функция для плавной анимации
function playAnim(element) {
    if (!element) return;
    element.classList.remove('click-anim');
    void element.offsetWidth; // Trigger reflow
    element.classList.add('click-anim');
}

// 1. РЕНДЕР КРОВАТЕЙ
function renderBeds() {
    const beds = MODULES.filter(m => m.type === 'bed');
    els.bedsContainer.innerHTML = beds.map(bed => {
        const fullWidth = bed.width + CONSTANTS.BED_FRAME_WIDTH_ADD;
        // Добавляем id и передаем this в onclick
        return `
        <div class="card" id="card-${bed.id}" onclick="selectBed(this, '${bed.id}')">
            <div class="card-img-wrap ratio-1-1">
                <img src="${bed.image}" alt="${bed.name}" loading="lazy">
            </div>
            <h3>${bed.name}</h3>
            <p>Габарит: ${fullWidth}x220 см</p>
            <div class="card-price">${bed.price.toLocaleString()} ₽</div>
        </div>
        `;
    }).join('');
}

// 2. РЕНДЕР МОДУЛЕЙ
function renderModulesList() {
    const hasSofa = state.cart.some(i => i.type === 'sofa');
    
    // Диваны
    const sofas = MODULES.filter(m => m.type === 'sofa');
    els.sofasContainer.innerHTML = sofas.map(item => {
        return `
            <div class="card" id="card-${item.id}" onclick="toggleSofa(this, '${item.id}')">
                <div class="card-img-wrap ratio-1-1">
                    <img src="${item.image}" alt="${item.name}" loading="lazy">
                </div>
                <h3>${item.name}</h3>
                <p>Встраивается</p>
                <div class="card-price">${item.price.toLocaleString()} ₽</div>
            </div>
        `;
    }).join('');

    // Шкафы
    const storage = MODULES.filter(m => m.type === 'storage');
    els.storageContainer.innerHTML = storage.map(item => {
        const displayPrice = (hasSofa && item.priceWithSofa) ? item.priceWithSofa : item.price;
        return `
            <div class="card" onclick="addStorage(this, '${item.id}')">
                <div class="card-img-wrap ratio-3-4">
                    <img src="${item.image}" alt="${item.name}" loading="lazy">
                </div>
                <h3>${item.name}</h3>
                <p>Ширина ${item.width} см</p>
                <div class="card-price">${displayPrice.toLocaleString()} ₽</div>
            </div>
        `;
    }).join('');
}

// --- ЛОГИКА ---

// element передается через this из HTML
window.selectBed = (element, id) => {
    playAnim(element); // Запускаем анимацию сразу

    if (state.selectedBed?.id === id) return;
    const bed = MODULES.find(m => m.id === id);
    
    // Снимаем выделение со всех кроватей (через классы, без перерисовки)
    els.bedsContainer.querySelectorAll('.card').forEach(el => el.classList.remove('selected'));
    // Ставим выделение текущей
    if(element) element.classList.add('selected');

    // Чистим старую кровать, добавляем новую
    state.cart = state.cart.filter(item => item.type !== 'bed');
    state.selectedBed = bed;
    
    addToCartInternal(bed, true); 

    // Разблокировка интерфейса
    if (!els.step2.classList.contains('active')) {
        els.step2.classList.add('active'); 
        els.step3.classList.remove('hidden');
        els.bottomBar.classList.remove('hidden');
        setTimeout(() => els.step2.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
    
    calculateTotals();
};

window.toggleSofa = (element, id) => {
    if (!state.selectedBed) return;
    playAnim(element);

    const existingSofaIndex = state.cart.findIndex(i => i.type === 'sofa');
    
    // Если этот диван уже выбран
    if (existingSofaIndex !== -1 && state.cart[existingSofaIndex].id === id) {
        // Удаляем
        removeFromCart(state.cart[existingSofaIndex].uniqueId);
        element.classList.remove('selected');
    } else {
        // Если был другой диван, нужно снять выделение с его карточки визуально
        if (existingSofaIndex !== -1) {
            const oldId = state.cart[existingSofaIndex].id;
            const oldEl = document.getElementById(`card-${oldId}`);
            if (oldEl) oldEl.classList.remove('selected');
            
            // Удаляем старый из данных
            state.cart.splice(existingSofaIndex, 1);
        }
        
        // Добавляем новый
        const item = MODULES.find(m => m.id === id);
        addToCartInternal(item);
        element.classList.add('selected');
    }
};

window.addStorage = (element, id) => {
    if (!state.selectedBed) return;
    playAnim(element);
    
    const item = MODULES.find(m => m.id === id);
    addToCartInternal(item);
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
};

function addToCartInternal(item, isBed = false) {
    const uniqueId = Date.now() + Math.random().toString(36).substr(2, 9);
    const colorOptions = item.category === 'ldsp' ? COLORS.LDSP : COLORS.FABRIC;
    
    const cartItem = {
        ...item,
        uniqueId: uniqueId,
        selectedColorId: colorOptions[0].id,
        isNew: true
    };

    // Просто пушим в массив, сортировка будет в renderCart
    state.cart.push(cartItem);

    renderCart(); 
    calculateTotals();
}

window.removeFromCart = (uniqueId) => {
    const index = state.cart.findIndex(i => i.uniqueId == uniqueId);
    if (index === -1) return;
    
    const type = state.cart[index].type;
    const itemId = state.cart[index].id;
    
    if (type === 'bed') {
        state.selectedBed = null;
        state.cart = [];
        els.step2.classList.remove('active');
        els.step3.classList.add('hidden');
        els.bottomBar.classList.add('hidden');
        
        // Снимаем выделения визуально
        document.querySelectorAll('.card.selected').forEach(el => el.classList.remove('selected'));
    } else {
        state.cart.splice(index, 1);
        if (type === 'sofa') {
            // Снимаем выделение с дивана
            const sofaEl = document.getElementById(`card-${itemId}`);
            if (sofaEl) sofaEl.classList.remove('selected');
        }
    }
    
    renderCart();
    calculateTotals();
};

window.changeColor = (uniqueId, colorId) => {
    const item = state.cart.find(i => i.uniqueId == uniqueId);
    if (!item || item.selectedColorId === colorId) return;

    item.selectedColorId = colorId;
    
    const colorOpts = item.category === 'ldsp' ? COLORS.LDSP : COLORS.FABRIC;
    const colorObj = colorOpts.find(c => c.id === colorId);

    // Точечное обновление текста
    const textEl = document.getElementById(`meta-${uniqueId}`);
    if (textEl) {
        let dimText = '';
        if (item.type === 'bed') dimText = `${item.width + CONSTANTS.BED_FRAME_WIDTH_ADD}x220 см`;
        else if (item.type === 'storage') dimText = `${item.width} см ширина`;
        else dimText = 'Встраиваемый модуль';
        
        textEl.innerText = `${dimText} • ${colorObj.name}`;
    }

    // Точечное обновление свотчей
    const container = document.getElementById(`swatches-${uniqueId}`);
    if (container) {
        const swatches = container.querySelectorAll('.swatch');
        swatches.forEach(s => s.classList.remove('active'));
        
        const targetSwatch = document.getElementById(`swatch-${uniqueId}-${colorId}`);
        if (targetSwatch) targetSwatch.classList.add('active');
    }
    
    if (tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
};

// --- RENDER CART С СОРТИРОВКОЙ ---
function renderCart() {
    if (state.cart.length === 0) {
        els.cartList.innerHTML = '';
        return;
    }

    // СОРТИРОВКА: Кровать(1) -> Диван(2) -> Остальное(3)
    const sortedCart = [...state.cart].sort((a, b) => {
        const getRank = (type) => {
            if (type === 'bed') return 1;
            if (type === 'sofa') return 2;
            return 3;
        };
        return getRank(a.type) - getRank(b.type);
    });

    const hasSofa = state.cart.some(i => i.type === 'sofa');

    els.cartList.innerHTML = sortedCart.map(item => {
        const colorOpts = item.category === 'ldsp' ? COLORS.LDSP : COLORS.FABRIC;
        const finalPrice = (hasSofa && item.priceWithSofa) ? item.priceWithSofa : item.price;
        const selectedColorName = colorOpts.find(c => c.id === item.selectedColorId)?.name || '';

        let dimText = '';
        if (item.type === 'bed') dimText = `${item.width + CONSTANTS.BED_FRAME_WIDTH_ADD}x220 см`;
        else if (item.type === 'storage') dimText = `${item.width} см ширина`;
        else dimText = 'Встраиваемый модуль';

        const metaId = `meta-${item.uniqueId}`;
        const swatchesContainerId = `swatches-${item.uniqueId}`;

        const swatchesHtml = colorOpts.map(c => `
            <div 
                id="swatch-${item.uniqueId}-${c.id}"
                class="swatch ${c.id === item.selectedColorId ? 'active' : ''}" 
                style="background-image: url('${c.image}'); background-color: #eee;"
                onclick="changeColor('${item.uniqueId}', '${c.id}')"
            ></div>
        `).join('');

        const animationClass = item.isNew ? 'animate-new' : '';
        item.isNew = false; 

        return `
            <div class="cart-item ${animationClass}">
                <div class="cart-main">
                    <img src="${item.image}" class="cart-thumb">
                    <div class="cart-info">
                        <div class="cart-name">${item.name}</div>
                        <div class="cart-meta" id="${metaId}">${dimText} • ${selectedColorName}</div>
                    </div>
                    <div class="cart-actions">
                        <div class="cart-item-price">${finalPrice.toLocaleString()} ₽</div>
                        ${item.type !== 'bed' ? `<div class="cart-remove" onclick="removeFromCart('${item.uniqueId}')">Удалить</div>` : ''}
                    </div>
                </div>
                <div class="cart-colors-row" id="${swatchesContainerId}">
                    ${swatchesHtml}
                </div>
            </div>
        `;
    }).join('');
}

function calculateTotals() {
    if (!state.selectedBed) return;
    const hasSofa = state.cart.some(i => i.type === 'sofa');

    let totalPrice = 0;
    let totalWeight = 0;
    let totalWidth = 0;
    let maxDepth = 0;
    let maxHeight = 0;

    state.cart.forEach(item => {
        const price = (hasSofa && item.priceWithSofa) ? item.priceWithSofa : item.price;
        totalPrice += price;
        totalWeight += item.weight;

        if (item.type === 'bed') {
            totalWidth += (item.width + CONSTANTS.BED_FRAME_WIDTH_ADD);
            maxDepth = Math.max(maxDepth, item.depth);
            maxHeight = Math.max(maxHeight, item.height);
        } else if (item.type !== 'sofa') {
            totalWidth += item.width;
            maxDepth = Math.max(maxDepth, item.depth);
            maxHeight = Math.max(maxHeight, item.height);
        }
    });

    if (hasSofa) {
        maxDepth += CONSTANTS.SOFA_DEPTH_ADD;
        maxHeight += CONSTANTS.SOFA_HEIGHT_ADD;
    }

    animateValue(els.totalPrice, parseInt(els.totalPrice.innerText.replace(/\D/g,'')) || 0, totalPrice, 400);
    els.totalDims.innerText = `${totalWidth} x ${maxHeight} x ${maxDepth} см`;
    els.totalWeight.innerText = `Вес: ~${totalWeight} кг`;
}

function animateValue(obj, start, end, duration) {
    if (start === end) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString() + ' ₽';
        if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
}

// ... (весь предыдущий код выше без изменений) ...

els.btnSubmit.addEventListener('click', () => {
    // 1. Проверка на пустую корзину
    if (state.cart.length === 0) {
        // Можно добавить визуальный эффект, если корзина пуста (например, вибрацию)
        if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
        return;
    }
    
    const hasSofa = state.cart.some(i => i.type === 'sofa');
    
    // 2. Сортировка
    const sortedCart = [...state.cart].sort((a, b) => {
        const getRank = (type) => { if (type === 'bed') return 1; if (type === 'sofa') return 2; return 3; };
        return getRank(a.type) - getRank(b.type);
    });
    
    // 3. Формирование объекта
    const report = {
        total: els.totalPrice.innerText,
        dims: els.totalDims.innerText,
        weight: els.totalWeight.innerText,
        items: sortedCart.map(i => ({
            name: i.name,
            color: (i.category === 'ldsp' ? COLORS.LDSP : COLORS.FABRIC).find(c => c.id === i.selectedColorId)?.name,
            price: (hasSofa && i.priceWithSofa) ? i.priceWithSofa : i.price
        }))
    };

    // 4. Отправка данных
    // Просто отправляем. Telegram сам разберется.
    try {
        tg.sendData(JSON.stringify(report));
        // На всякий случай закрываем окно, хотя sendData делает это сам
        setTimeout(() => tg.close(), 100); 
    } catch (e) {
        alert("Ошибка отправки: " + e.message);
    }
});

init();