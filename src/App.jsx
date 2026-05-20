import React, { useState } from 'react';
import database from '../data.json';

function App() {
  const [search, setSearch] = useState('');
  const [selectedType, setSelectedType] = useState('All');
  const [selectedDevice, setSelectedDevice] = useState(database[0]?.id || '');
  const [copiedId, setCopiedId] = useState(null);

  const filteredDevices = database.filter(dev => {
    if (selectedType === 'All') return true;
    return dev.type.toLowerCase().includes(selectedType.toLowerCase());
  });

  const currentDevice = database.find(dev => dev.id === selectedDevice);

  const filteredActions = currentDevice?.actions.filter(action =>
    action.name.toLowerCase().includes(search.toLowerCase()) ||
    action.command.toLowerCase().includes(search.toLowerCase()) ||
    action.description.toLowerCase().includes(search.toLowerCase())
  ) || [];

  const copyToClipboard = (text, idx) => {
    navigator.clipboard.writeText(text);
    setCopiedId(idx);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', fontFamily: "'Inter', 'Segoe UI', Roboto, Helvetica, sans-serif", padding: '25px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      
      <div style={{ width: '100%', maxWidth: '1400px' }}>
        {/* Шапка сайта */}
        <header style={{ borderBottom: '1px solid #334155', paddingBottom: '20px', marginBottom: '25px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '15px' }}>
          <div>
            <h1 style={{ fontSize: '28px', fontWeight: '800', margin: '0 0 8px 0', color: '#38bdf8', letterSpacing: '-0.5px' }}>Справочник команд КД / OLT / FTTx</h1>
            <div style={{ color: '#94a3b8', fontSize: '14px', fontWeight: '500' }}>Инженерная база знаний</div>
          </div>
          
          <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Поиск команды или описания..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ background: '#1e293b', color: '#f8fafc', border: '1px solid #475569', padding: '12px 18px', borderRadius: '8px', minWidth: '350px', outline: 'none', fontSize: '14px', fontFamily: 'inherit', transition: 'border-color 0.2s' }}
            />

            <select 
              value={selectedType} 
              onChange={(e) => setSelectedType(e.target.value)}
              style={{ background: '#1e293b', color: '#f8fafc', border: '1px solid #475569', padding: '12px 18px', borderRadius: '8px', outline: 'none', cursor: 'pointer', fontSize: '14px', fontFamily: 'inherit', fontWeight: '500' }}
            >
              <option value="All">Все технологии</option>
              <option value="xDSL">xDSL (ADSL/VDSL)</option>
              <option value="FTTx">FTTx (Коммутаторы)</option>
              <option value="xPON">xPON (OLT)</option>
            </select>
          </div>
        </header>

        {/* Основная рабочая зона */}
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '30px' }}>
          
          {/* Боковое меню со списком железок */}
          <aside style={{ background: '#1e293b', padding: '15px', borderRadius: '12px', height: 'fit-content', border: '1px solid #334155' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {filteredDevices.map(dev => (
                <button
                  key={dev.id}
                  onClick={() => { setSelectedDevice(dev.id); setSearch(''); }}
                  style={{
                    textAlign: 'left', padding: '14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    background: selectedDevice === dev.id ? '#0ea5e9' : 'transparent',
                    color: selectedDevice === dev.id ? '#ffffff' : '#cbd5e1',
                    fontWeight: selectedDevice === dev.id ? '600' : '500',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <div style={{ fontSize: '11px', color: selectedDevice === dev.id ? '#e0f2fe' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>
                    {dev.type}
                  </div>
                  <div style={{ fontSize: '15px' }}>{dev.vendor} {dev.model}</div>
                </button>
              ))}
            </div>
          </aside>

          {/* Список команд */}
          <main>
            {currentDevice ? (
              <div style={{ background: '#1e293b', padding: '30px', borderRadius: '12px', border: '1px solid #334155', minHeight: '500px' }}>
                <h2 style={{ fontSize: '24px', margin: '0 0 25px 0', fontWeight: '700', borderBottom: '1px solid #334155', paddingBottom: '15px' }}>
                  {currentDevice.vendor} <span style={{ color: '#38bdf8' }}>{currentDevice.model}</span>
                </h2>

                {filteredActions.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {filteredActions.map((action, idx) => (
                      <div key={idx} style={{ background: '#0f172a', borderRadius: '10px', padding: '20px', border: '1px solid #1e293b' }}>
                        <div style={{ fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#e2e8f0' }}>
                          {action.name}
                        </div>
                        
                        {/* Строка с CLI командой - моноширинный шрифт */}
                        <div style={{ display: 'flex', background: '#020617', borderRadius: '8px', border: '1px solid #334155', overflow: 'hidden' }}>
                          <code style={{ flex: 1, padding: '14px 18px', fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace", color: '#10b981', fontSize: '14.5px', whiteSpace: 'nowrap', overflowX: 'auto' }}>
                            {action.command}
                          </code>
                          <button
                            onClick={() => copyToClipboard(action.command, idx)}
                            style={{
                              background: copiedId === idx ? '#059669' : '#334155', color: '#fff', border: 'none', padding: '0 25px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: '600', minWidth: '130px', fontSize: '13px', transition: 'background 0.2s'
                            }}
                          >
                            {copiedId === idx ? 'СКОПИРОВАНО' : 'КОПИРОВАТЬ'}
                          </button>
                        </div>

                        <div style={{ fontSize: '14px', color: '#94a3b8', marginTop: '14px', lineHeight: '1.6', fontWeight: '400' }}>
                          {action.description}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#64748b', fontSize: '15px', padding: '20px 0' }}>Для данного устройства команд не найдено.</div>
                )}
              </div>
            ) : (
              <div style={{ color: '#64748b', padding: '30px', background: '#1e293b', borderRadius: '12px', textAlign: 'center' }}>Выберите устройство из списка слева.</div>
            )}
          </main>

        </div>
      </div>
    </div>
  );
}

export default App;